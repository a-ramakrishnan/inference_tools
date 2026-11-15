"""The inference gateway: one OpenAI-compatible endpoint in front of several llama.cpp servers.

    ibench gateway [--config gateway.toml] [--no-start]

Per request:
  1. auth      Bearer API key from the config file → a key name (the key itself is never stored)
  2. route     the requested model name picks a backend; "auto" sends long prompts to the "quality" backend
  3. queue     each backend admits at most `max_concurrency` requests; up to `max_queue` more wait in line,
               beyond that the gateway answers 429 straight away
  4. proxy     the request goes to llama-server's /v1/chat/completions; streams pass through chunk by chunk
  5. account   one usage row (key, model, backend, tokens, queue wait, TTFT, generation time) in SQLite,
               plus an OpenTelemetry trace when an endpoint is configured

Endpoints: POST /v1/chat/completions, GET /v1/models, and for the dashboard GET /gateway/status,
/gateway/requests, /gateway/usage, /gateway/usage.csv, /gateway/events (server-sent events).
"""

from __future__ import annotations

import asyncio
import csv
import io
import json
import logging
import time
import uuid
from collections import deque
from contextlib import asynccontextmanager
from dataclasses import dataclass, field

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response, StreamingResponse

from .. import MODELS_DIR, RESULTS_DIR, ROOT
from ..server import LlamaServer, ServerConfig
from .config import BackendConfig, GatewayConfig, load
from .store import Store
from .tracing import Tracer

log = logging.getLogger("ibench.gateway")


@dataclass
class Backend:
    cfg: BackendConfig
    url: str = ""
    healthy: bool = False
    managed: LlamaServer | None = None
    active: int = 0
    waiting: int = 0
    served: int = 0
    rejected: int = 0
    sem: asyncio.Semaphore = field(default=None)  # type: ignore[assignment]

    def __post_init__(self):
        self.sem = asyncio.Semaphore(self.cfg.max_concurrency)
        self.url = self.cfg.url.rstrip("/")

    def snapshot(self) -> dict:
        c = self.cfg
        return {"name": c.name, "model": c.model, "gguf": c.gguf, "url": self.url, "healthy": self.healthy,
                "managed": self.managed is not None, "active": self.active, "waiting": self.waiting,
                "max_concurrency": c.max_concurrency, "max_queue": c.max_queue, "slots": c.slots,
                "threads": c.threads, "gpu_layers": c.gpu_layers, "ctx_per_slot": c.ctx_per_slot,
                "served": self.served, "rejected": self.rejected}


class Events:
    """Fan-out of request lifecycle events to dashboard SSE clients."""

    def __init__(self):
        self.subs: set[asyncio.Queue] = set()
        self.recent: deque = deque(maxlen=500)

    def emit(self, kind: str, data: dict) -> None:
        ev = {"type": kind, "t": time.time(), "data": data}
        self.recent.append(ev)
        for q in list(self.subs):
            q.put_nowait(ev)


class Gateway:
    def __init__(self, cfg: GatewayConfig, start_backends: bool = True):
        self.cfg = cfg
        self.start_backends = start_backends
        self.backends: dict[str, Backend] = {}
        self.by_model: dict[str, Backend] = {}
        self.store = Store(cfg.db_path)
        self.tracer = Tracer(cfg.otlp_endpoint)
        self.events = Events()
        self.client: httpx.AsyncClient | None = None
        self.started_at = time.time()

    # ------------------------------------------------------------ lifecycle
    async def start(self) -> None:
        self.client = httpx.AsyncClient(timeout=httpx.Timeout(600, connect=10),
                                        limits=httpx.Limits(max_connections=256, max_keepalive_connections=64))
        for bc in self.cfg.backends:
            b = Backend(bc)
            self.backends[bc.name] = b
            self.by_model[bc.model] = b
        loop = asyncio.get_running_loop()
        for b in self.backends.values():
            if not b.url and self.start_backends:
                await loop.run_in_executor(None, self._start_managed, b)
        self._health_task = asyncio.create_task(self._health_loop())

    def _start_managed(self, b: Backend) -> None:
        c = b.cfg
        cfg = ServerConfig(model_path=str((MODELS_DIR / c.gguf).relative_to(ROOT)), threads=c.threads,
                           parallel=c.slots, ctx_per_slot=c.ctx_per_slot, gpu_layers=c.gpu_layers, alias=c.model)
        srv = LlamaServer(cfg, ROOT / "gateway-data" / "logs" / f"{c.name}.log")
        srv.start()
        b.managed, b.url, b.healthy = srv, srv.url, True
        log.warning("backend %s (%s) ready at %s in %.1fs", c.name, c.gguf, srv.url, srv.load_seconds)

    async def _health_loop(self) -> None:
        while True:
            for b in self.backends.values():
                if not b.url:
                    b.healthy = False
                    continue
                try:
                    r = await self.client.get(b.url + "/health", timeout=3)
                    b.healthy = r.status_code == 200
                except httpx.HTTPError:
                    b.healthy = False
            self.events.emit("status", self.status())
            await asyncio.sleep(1)

    async def stop(self) -> None:
        if getattr(self, "_health_task", None):
            self._health_task.cancel()
        for b in self.backends.values():
            if b.managed:
                b.managed.stop()
        if self.client:
            await self.client.aclose()
        self.tracer.shutdown()

    def status(self) -> dict:
        return {"backends": [b.snapshot() for b in self.backends.values()],
                "models": ["auto", *self.by_model], "keys": sorted(set(self.cfg.keys.values())),
                "tracing": {"enabled": self.tracer.enabled, "endpoint": self.cfg.otlp_endpoint or None,
                            "ui_url": self.cfg.trace_ui_url or None, "error": self.tracer.error},
                "long_prompt_chars": self.cfg.long_prompt_chars, "uptime_s": round(time.time() - self.started_at)}

    # ------------------------------------------------------------ per request
    def auth(self, request: Request) -> str:
        h = request.headers.get("authorization", "")
        key = h[7:].strip() if h.lower().startswith("bearer ") else request.headers.get("x-api-key", "")
        name = self.cfg.keys.get(key)
        if not name:
            raise HTTPException(401, {"error": {"message": "invalid or missing API key", "type": "authentication_error"}})
        return name

    def route(self, body: dict) -> tuple[Backend, str]:
        model = body.get("model") or "auto"
        if model in self.by_model:
            return self.by_model[model], f"model={model}"
        if model in self.backends:
            return self.backends[model], f"backend={model}"
        if model == "auto":
            chars = sum(len(m.get("content") or "") if isinstance(m.get("content"), str)
                        else sum(len(p.get("text", "")) for p in m.get("content") or []) for m in body.get("messages", []))
            names = list(self.backends)
            if chars > self.cfg.long_prompt_chars and "quality" in self.backends:
                return self.backends["quality"], f"auto: {chars} chars > {self.cfg.long_prompt_chars}"
            first = self.backends.get("fast") or self.backends[names[0]]
            return first, f"auto: {chars} chars <= {self.cfg.long_prompt_chars}"
        raise HTTPException(404, {"error": {"message": f"unknown model '{model}'. Try one of: auto, {', '.join(self.by_model)}",
                                            "type": "invalid_request_error"}})

    def _finish(self, row: dict, t0: float, t0_ns: int, acq: float | None, first: float | None, end: float) -> None:
        to_ns = lambda t: t0_ns + int((t - t0) * 1e9)
        row["queue_ms"] = round(((acq or end) - t0) * 1000, 2)
        row["ttft_ms"] = round((first - t0) * 1000, 2) if first else None
        row["gen_ms"] = round((end - first) * 1000, 2) if first else None
        row["total_ms"] = round((end - t0) * 1000, 2)
        ct = row.get("completion_tokens") or 0
        row["decode_tps"] = round((ct - 1) / (end - first), 3) if first and ct > 1 and end > first else None
        row["trace_id"] = self.tracer.record(row, t0_ns, to_ns(acq) if acq else None, to_ns(first) if first else None,
                                             to_ns(end)) or row["id"].replace("req_", "")
        try:
            self.store.insert(row)
        except Exception as e:  # accounting must never break serving
            log.error("usage write failed: %s", e)
        self.events.emit("request_done", row)

    async def chat(self, request: Request) -> Response:
        key_name = self.auth(request)
        try:
            body = await request.json()
        except json.JSONDecodeError:
            raise HTTPException(400, {"error": {"message": "body must be JSON", "type": "invalid_request_error"}})
        b, reason = self.route(body)
        rid = "req_" + uuid.uuid4().hex[:24]
        t0, t0_ns = time.perf_counter(), time.time_ns()
        stream = bool(body.get("stream"))
        row = {"id": rid, "ts": time.time(), "key_name": key_name, "model_requested": body.get("model") or "auto",
               "model": b.cfg.model, "backend": b.cfg.name, "route_reason": reason, "stream": int(stream),
               "tag": request.headers.get("x-ibench-tag")}
        if not b.healthy:
            row.update(status="error", http_status=503, error="backend unavailable")
            self._finish(row, t0, t0_ns, None, None, time.perf_counter())
            raise HTTPException(503, {"error": {"message": f"backend {b.cfg.name} is not ready", "type": "server_error"}})
        if b.waiting >= b.cfg.max_queue and b.sem.locked():
            b.rejected += 1
            row.update(status="rejected", http_status=429, error="queue full")
            self._finish(row, t0, t0_ns, None, None, time.perf_counter())
            return JSONResponse({"error": {"message": f"backend {b.cfg.name} queue is full ({b.cfg.max_queue} waiting)",
                                           "type": "rate_limit_error"}}, status_code=429,
                                headers={"retry-after": "1", "x-request-id": rid})
        upstream = {**body, "model": b.cfg.model}
        if stream:
            upstream["stream_options"] = {**(body.get("stream_options") or {}), "include_usage": True}
        self.events.emit("request_queued", {"id": rid, "backend": b.cfg.name, "key_name": key_name})
        headers = {"x-request-id": rid, "x-ibench-backend": b.cfg.name, "x-ibench-route": reason}
        if stream:
            return StreamingResponse(self._stream(b, upstream, row, t0, t0_ns, bool((body.get("stream_options") or {}).get("include_usage"))),
                                     media_type="text/event-stream", headers={**headers, "cache-control": "no-cache"})
        return await self._unary(b, upstream, row, t0, t0_ns, headers)

    async def _acquire(self, b: Backend) -> float:
        b.waiting += 1
        try:
            await b.sem.acquire()
        finally:
            b.waiting -= 1
        b.active += 1
        return time.perf_counter()

    def _release(self, b: Backend) -> None:
        b.active -= 1
        b.served += 1
        b.sem.release()

    async def _unary(self, b, upstream, row, t0, t0_ns, headers) -> Response:
        acq = await self._acquire(b)
        first = None
        try:
            r = await self.client.post(b.url + "/v1/chat/completions", json=upstream)
            end = time.perf_counter()
            data = r.json()
            if r.status_code >= 400:
                row.update(status="error", http_status=r.status_code, error=json.dumps(data)[:300])
            else:
                first = acq + (data.get("timings", {}).get("prompt_ms") or 0) / 1000   # no stream: TTFT from server prefill
                self._usage(row, data)
                row.update(status="ok", http_status=200)
            q = {"queue_ms": round((acq - t0) * 1000, 1)}
            return JSONResponse(data, status_code=r.status_code, headers={**headers, "x-ibench-queue-ms": str(q["queue_ms"])})
        except httpx.HTTPError as e:
            end = time.perf_counter()
            row.update(status="error", http_status=502, error=f"{type(e).__name__}: {e}")
            return JSONResponse({"error": {"message": "backend error", "type": "server_error"}}, status_code=502, headers=headers)
        finally:
            self._release(b)
            self._finish(row, t0, t0_ns, acq, first, time.perf_counter())

    async def _stream(self, b, upstream, row, t0, t0_ns, client_wants_usage):
        acq = first = None
        try:
            acq = await self._acquire(b)
            self.events.emit("request_started", {"id": row["id"], "backend": b.cfg.name, "queue_ms": round((acq - t0) * 1000, 1)})
            async with self.client.stream("POST", b.url + "/v1/chat/completions", json=upstream) as r:
                if r.status_code >= 400:
                    err = (await r.aread()).decode(errors="replace")[:300]
                    row.update(status="error", http_status=r.status_code, error=err)
                    yield f"data: {json.dumps({'error': {'message': err, 'type': 'server_error'}})}\n\n"
                    return
                async for line in r.aiter_lines():
                    if not line:
                        continue
                    if line.startswith("data: ") and line != "data: [DONE]":
                        try:
                            chunk = json.loads(line[6:])
                        except json.JSONDecodeError:
                            chunk = {}
                        if chunk.get("usage"):
                            self._usage(row, chunk)
                            if not client_wants_usage:
                                continue                  # the client didn't ask for the usage chunk
                        if first is None and any((c.get("delta") or {}).get("content") for c in chunk.get("choices", [])):
                            first = time.perf_counter()
                            self.events.emit("first_token", {"id": row["id"], "ttft_ms": round((first - t0) * 1000, 1)})
                    yield line + "\n\n"
            row.update(status="ok", http_status=200)
        except asyncio.CancelledError:
            row.update(status="cancelled", http_status=499, error="client disconnected")
            raise
        except httpx.HTTPError as e:
            row.update(status="error", http_status=502, error=f"{type(e).__name__}: {e}")
            yield f"data: {json.dumps({'error': {'message': 'backend error', 'type': 'server_error'}})}\n\n"
        finally:
            if acq is not None:
                self._release(b)
            self._finish(row, t0, t0_ns, acq, first, time.perf_counter())

    @staticmethod
    def _usage(row: dict, data: dict) -> None:
        u = data.get("usage") or {}
        row["prompt_tokens"] = u.get("prompt_tokens")
        row["completion_tokens"] = u.get("completion_tokens")
        row["cached_tokens"] = (u.get("prompt_tokens_details") or {}).get("cached_tokens")
        row["server_prompt_ms"] = (data.get("timings") or {}).get("prompt_ms")


def create_app(config_path: str | None = None, start_backends: bool = True) -> FastAPI:
    gw = Gateway(load(config_path), start_backends=start_backends)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        await gw.start()
        yield
        await gw.stop()

    app = FastAPI(title="ibench gateway", version="0.1.0", lifespan=lifespan)
    app.state.gw = gw
    app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"],
                       expose_headers=["x-request-id", "x-ibench-backend", "x-ibench-route", "x-ibench-queue-ms"])

    @app.exception_handler(HTTPException)
    async def _http_error(request: Request, exc: HTTPException):
        body = exc.detail if isinstance(exc.detail, dict) else {"error": {"message": str(exc.detail)}}
        return JSONResponse(body, status_code=exc.status_code)

    @app.post("/v1/chat/completions")
    async def chat(request: Request):
        return await gw.chat(request)

    @app.get("/v1/models")
    async def models():
        return {"object": "list", "data": [{"id": m, "object": "model", "owned_by": "ibench"} for m in ["auto", *gw.by_model]]}

    @app.get("/health")
    async def health():
        return {"ok": any(b.healthy for b in gw.backends.values())}

    @app.get("/gateway/status")
    async def status():
        return gw.status()

    @app.get("/gateway/requests")
    async def requests(limit: int = 200, tag: str | None = None):
        return await asyncio.to_thread(gw.store.recent, min(limit, 2000), tag)

    @app.get("/gateway/usage")
    async def usage(group: str = "key_name", since: float | None = None):
        try:
            return await asyncio.to_thread(gw.store.usage, group, since)
        except ValueError as e:
            raise HTTPException(400, str(e))

    @app.get("/gateway/usage.csv")
    async def usage_csv():
        rows = await asyncio.to_thread(gw.store.all_rows)
        buf = io.StringIO()
        if rows:
            w = csv.DictWriter(buf, list(rows[0]))
            w.writeheader()
            w.writerows(rows)
        return Response(buf.getvalue(), media_type="text/csv",
                        headers={"content-disposition": "attachment; filename=gateway-usage.csv"})

    @app.get("/gateway/events")
    async def events():
        q: asyncio.Queue = asyncio.Queue()
        gw.events.subs.add(q)

        async def gen():
            try:
                yield ": connected\n\n"
                yield f"data: {json.dumps({'type': 'status', 't': time.time(), 'data': gw.status()})}\n\n"
                while True:
                    try:
                        ev = await asyncio.wait_for(q.get(), timeout=15)
                        yield f"data: {json.dumps(ev)}\n\n"
                    except asyncio.TimeoutError:
                        yield ": keep-alive\n\n"
            finally:
                gw.events.subs.discard(q)

        return StreamingResponse(gen(), media_type="text/event-stream", headers={"cache-control": "no-cache"})

    return app
