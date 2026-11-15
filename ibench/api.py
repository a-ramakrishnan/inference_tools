"""HTTP API for the dashboard.

    uvicorn ibench.api:app --port 8000          (or: ibench serve)

One sweep runs at a time, in a background thread. Live progress goes to every open /api/events stream
(server-sent events). Everything a sweep produces is in results/<id>/, so a results folder copied from another
machine (a cloud instance, Colab) shows up here like a local one.
"""

from __future__ import annotations

import asyncio
import csv
import io
import json
import shutil
import threading
import time
import zipfile
from collections import deque
from pathlib import Path

import os
import uuid

import httpx
from fastapi import FastAPI, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.background import BackgroundTask

from . import RESULTS_DIR, ROOT
from .hardware import THREAD_PRESETS, detect, resolve_threads
from .presets import PRESETS
from .sweep import Sweep, SweepSpec, list_models

app = FastAPI(title="ibench", version="0.1.0")
app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
                   allow_methods=["*"], allow_headers=["*"])

_NUMERIC_SKIP = {"sweep_id", "run_id", "machine", "arch", "model", "quant", "device", "threads_preset", "timestamp",
                 "error", "server", "thermal"}


# ---------------------------------------------------------------- live events
class EventBus:
    """Fan-out from the sweep thread to any number of SSE clients. Keeps recent events for late joiners."""

    def __init__(self):
        self.subscribers: set[asyncio.Queue] = set()
        self.loop: asyncio.AbstractEventLoop | None = None
        self.recent: deque = deque(maxlen=4000)
        self.seq = 0
        self.lock = threading.Lock()

    def publish(self, kind: str, data: dict) -> None:
        with self.lock:
            self.seq += 1
            ev = {"seq": self.seq, "type": kind, "t": time.time(), "data": data}
            if kind == "sweep_started":
                self.recent.clear()
            self.recent.append(ev)
        if self.loop:
            for q in list(self.subscribers):
                self.loop.call_soon_threadsafe(q.put_nowait, ev)


bus = EventBus()


class Active:
    sweep: Sweep | None = None
    thread: threading.Thread | None = None


@app.on_event("startup")
async def _startup():
    bus.loop = asyncio.get_running_loop()
    RESULTS_DIR.mkdir(exist_ok=True)


# ---------------------------------------------------------------- helpers
def _coerce(v: str):
    if v == "":
        return None
    try:
        f = float(v)
        return int(f) if f.is_integer() and "." not in v else f
    except ValueError:
        return v


def read_csv(path: Path) -> list[dict]:
    if not path.exists():
        return []
    with open(path, newline="") as f:
        return [{k: (v if k in _NUMERIC_SKIP else _coerce(v)) for k, v in row.items()} for row in csv.DictReader(f)]


def sweep_meta(sid: str) -> dict:
    path = RESULTS_DIR / sid / "meta.json"
    if not path.exists():
        raise HTTPException(404, f"no sweep {sid}")
    meta = json.loads(path.read_text())
    if meta.get("status") == "running" and not (Active.sweep and Active.sweep.id == sid):
        meta["status"] = "interrupted"   # the process that ran it is gone
    return meta


# ---------------------------------------------------------------- endpoints
@app.get("/api/system")
def system():
    hw = detect()
    return {
        "machine": hw,
        "models": list_models(),
        "thread_presets": [{"id": k, "label": v, "threads": resolve_threads(k, hw)} for k, v in THREAD_PRESETS.items()],
        "presets": PRESETS,
        "active_sweep": Active.sweep.id if Active.sweep and Active.thread and Active.thread.is_alive() else None,
    }


class SweepRequest(BaseModel):
    models: list[str]
    threads: list[str | int] = ["all_p"]
    prompt_tokens: list[int] = [200]
    concurrency: list[int] = [1]
    repeats: int = 3
    n_predict: int = 200
    gpu_layers: int = 0
    hourly_cost: float | None = None
    cooldown_s: float = 0
    control_run: bool = True
    label: str = ""


@app.post("/api/sweeps")
def start_sweep(req: SweepRequest):
    if Active.thread and Active.thread.is_alive():
        raise HTTPException(409, f"sweep {Active.sweep.id} is still running")
    known = {m["file"] for m in list_models()}
    missing = [m for m in req.models if m not in known]
    if not req.models or missing:
        raise HTTPException(400, f"unknown models: {missing}" if missing else "pick at least one model")
    if not (1 <= req.n_predict <= 4096) or not (1 <= req.repeats <= 20) or any(c < 1 or c > 64 for c in req.concurrency):
        raise HTTPException(400, "n_predict 1–4096, repeats 1–20, concurrency 1–64")
    spec = SweepSpec(**req.model_dump())
    Active.sweep = Sweep(spec, emit=bus.publish)
    Active.thread = threading.Thread(target=Active.sweep.run, daemon=True)
    Active.thread.start()
    return {"id": Active.sweep.id, "total_runs": len(spec.runs())}


@app.post("/api/sweeps/{sid}/cancel")
def cancel_sweep(sid: str):
    if not (Active.sweep and Active.sweep.id == sid and Active.thread.is_alive()):
        raise HTTPException(404, "that sweep is not running")
    Active.sweep.cancel()
    return {"ok": True}


@app.get("/api/sweeps")
def list_sweeps():
    out = []
    for d in sorted(RESULTS_DIR.glob("*/meta.json"), reverse=True):
        try:
            m = sweep_meta(d.parent.name)
        except Exception:
            continue
        out.append({k: m.get(k) for k in ("id", "status", "started_at", "finished_at", "duration_s", "total_runs",
                                          "done_runs", "error")} | {"label": m["spec"].get("label"),
                                                                     "machine": m["machine"]["label"],
                                                                     "arch": m["machine"]["arch"],
                                                                     "spec": m["spec"]})
    return out


@app.get("/api/sweeps/{sid}")
def get_sweep(sid: str):
    return {"meta": sweep_meta(sid), "runs": read_csv(RESULTS_DIR / sid / "runs.csv")}


@app.get("/api/sweeps/{sid}/requests")
def get_requests(sid: str):
    sweep_meta(sid)
    return read_csv(RESULTS_DIR / sid / "requests.csv")


@app.get("/api/sweeps/{sid}/memory")
def get_memory(sid: str, max_points: int = 1500):
    sweep_meta(sid)
    rows = read_csv(RESULTS_DIR / sid / "memory.csv")
    step = max(1, len(rows) // max_points)
    return rows[::step]


@app.get("/api/sweeps/{sid}/files/{name}")
def get_file(sid: str, name: str):
    if name not in ("runs.csv", "requests.csv", "memory.csv", "meta.json"):
        raise HTTPException(404)
    path = RESULTS_DIR / sid / name
    if not path.exists():
        raise HTTPException(404)
    return FileResponse(path, filename=f"{sid}-{name}")


@app.get("/api/sweeps/{sid}/logs")
def get_logs(sid: str, tail: int = 60):
    sweep_meta(sid)
    out = {}
    for p in sorted((RESULTS_DIR / sid / "logs").glob("*.log")):
        out[p.name] = p.read_text(errors="replace").splitlines()[-tail:]
    return out


@app.delete("/api/sweeps/{sid}")
def delete_sweep(sid: str):
    sweep_meta(sid)
    if Active.sweep and Active.sweep.id == sid and Active.thread.is_alive():
        raise HTTPException(409, "cancel it first")
    shutil.rmtree(RESULTS_DIR / sid)
    return {"ok": True}


@app.post("/api/import")
async def import_sweep(file: UploadFile):
    """A zip of one results/<id>/ folder from another machine."""
    data = await file.read()
    try:
        z = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        raise HTTPException(400, "not a zip file")
    metas = [n for n in z.namelist() if n.endswith("meta.json")]
    if len(metas) != 1:
        raise HTTPException(400, "the zip must hold exactly one sweep folder (with meta.json)")
    prefix = metas[0][: -len("meta.json")]
    meta = json.loads(z.read(metas[0]))
    sid = meta.get("id") or Path(prefix).name
    if not sid or "/" in sid or sid.startswith("."):
        raise HTTPException(400, "bad sweep id")
    dest = RESULTS_DIR / sid
    dest.mkdir(parents=True, exist_ok=True)
    for n in z.namelist():
        if not n.startswith(prefix) or n.endswith("/"):
            continue
        rel = Path(n[len(prefix):])
        if rel.is_absolute() or ".." in rel.parts:
            continue
        target = dest / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(z.read(n))
    return {"id": sid}


@app.get("/api/events")
async def events(since: int = 0):
    q: asyncio.Queue = asyncio.Queue()
    bus.subscribers.add(q)

    async def stream():
        try:
            yield ": connected\n\n"   # send headers now, so the browser sees the stream open even when idle
            for ev in list(bus.recent):
                if ev["seq"] > since:
                    yield f"data: {json.dumps(ev)}\n\n"
            while True:
                try:
                    ev = await asyncio.wait_for(q.get(), timeout=15)
                    yield f"data: {json.dumps(ev)}\n\n"
                except asyncio.TimeoutError:
                    yield ": keep-alive\n\n"
        finally:
            bus.subscribers.discard(q)

    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ---------------------------------------------------------------- gateway (a separate service; proxied for the dashboard)
GATEWAY_URL = os.environ.get("IBENCH_GATEWAY_URL", "http://127.0.0.1:8080").rstrip("/")
_PASS_REQ = {"authorization", "content-type", "accept", "x-ibench-tag"}
_PASS_RESP = {"content-type", "x-request-id", "x-ibench-backend", "x-ibench-route", "x-ibench-queue-ms", "retry-after",
              "content-disposition", "cache-control"}
_gw = httpx.AsyncClient(timeout=httpx.Timeout(None, connect=3))


@app.api_route("/api/gateway/{path:path}", methods=["GET", "POST"])
async def gateway_proxy(path: str, request: Request):
    req = _gw.build_request(request.method, f"{GATEWAY_URL}/{path}", params=request.query_params,
                            headers={k: v for k, v in request.headers.items() if k.lower() in _PASS_REQ},
                            content=await request.body())
    try:
        r = await _gw.send(req, stream=True)
    except httpx.HTTPError:
        raise HTTPException(502, f"gateway not reachable at {GATEWAY_URL}: start it with `ibench gateway`")
    return StreamingResponse(r.aiter_raw(), status_code=r.status_code,
                             headers={k: v for k, v in r.headers.items() if k.lower() in _PASS_RESP},
                             background=BackgroundTask(r.aclose))


class LoadRequest(BaseModel):
    requests: int = 30
    model: str = "qwen-fast"
    key: str = "sk-ibench-batch"
    prompt_chars: int = 400
    max_tokens: int = 64


@app.post("/api/gateway-load")
async def gateway_load(req: LoadRequest):
    """Send `requests` chat requests through the gateway at the same moment. They carry a tag, so the dashboard can
    pick them out of the gateway's request log."""
    if not 1 <= req.requests <= 200:
        raise HTTPException(400, "requests must be 1-200")
    from .prompts import passage
    tag = "load-" + uuid.uuid4().hex[:8]
    text = passage(n_sentences=max(1, req.prompt_chars // 70), seed=7)[: req.prompt_chars]

    async def one(i: int):
        try:
            await _gw.post(f"{GATEWAY_URL}/v1/chat/completions", timeout=600,
                           headers={"authorization": f"Bearer {req.key}", "x-ibench-tag": tag},
                           json={"model": req.model, "max_tokens": req.max_tokens,
                                 "messages": [{"role": "user", "content": f"Request {i}. {text}\n\nSummarize this."}]})
        except httpx.HTTPError:
            pass

    async def run():
        await asyncio.gather(*[one(i) for i in range(req.requests)])

    asyncio.create_task(run())
    return {"tag": tag, "requests": req.requests}


# ---------------------------------------------------------------- the built dashboard
_DIST = ROOT / "web" / "dist"
if _DIST.exists():
    app.mount("/assets", StaticFiles(directory=_DIST / "assets"), name="assets")

    @app.get("/{path:path}")
    def spa(path: str):
        f = _DIST / path
        return FileResponse(f if path and f.is_file() else _DIST / "index.html")
