"""Agent-style traffic versus chat traffic, sent through the gateway.

An agent session is a multi-turn tool-calling loop: a shared system prompt with tool definitions, one task,
then on every turn the model calls a tool, the tool result is appended, and the whole conversation is sent
again. The context grows each turn, so every request repeats a long prefix: the case prompt caching is for.

Chat traffic is the comparison: independent single-turn questions with a short prompt and a longer answer.

Conditions (each run with 1..N concurrent sessions):
  agent, prompt cache on    llama.cpp reuses the KV cache for the shared prefix (its default)
  agent, prompt cache off   every request recomputes its whole prompt (cache_prompt: false)
  chat                      single-turn requests, the default cache setting

Every request becomes one row in requests.csv. Tool results are synthetic and seeded, so the prompts are
reproducible; the model's own tool calls are real and are recorded as they come back.
"""
from __future__ import annotations

import asyncio
import csv
import json
import random
import time
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Callable

import httpx

from . import RESULTS_DIR
from .prompts import passage

AGENT_DIR = RESULTS_DIR / "agent"

TOOLS = [
    {"type": "function", "function": {"name": "search_code", "description": "Search the repository for a string or symbol. Returns matching lines with file paths.",
                                      "parameters": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}}},
    {"type": "function", "function": {"name": "read_file", "description": "Read a file from the repository.",
                                      "parameters": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}}},
    {"type": "function", "function": {"name": "run_tests", "description": "Run the test suite, optionally filtered by a pattern. Returns the test output.",
                                      "parameters": {"type": "object", "properties": {"pattern": {"type": "string"}}}}},
]

TASKS = [
    "Find where HTTP retries are implemented and explain the backoff policy.",
    "A user reports that uploads over 2 GB fail. Find the cause.",
    "Explain how configuration values are loaded and which source wins.",
    "Find why the nightly export job sometimes writes an empty file.",
    "Locate the code that validates API keys and check it for timing leaks.",
    "Work out why the cache hit rate dropped after the last release.",
    "Find every place that opens a database connection without closing it.",
    "Explain how the scheduler decides which job runs next.",
]

CHAT_QUESTIONS = [
    "Explain the difference between a process and a thread, with an example of when to use each.",
    "What are the trade-offs between SQL and NoSQL databases for a small web application?",
    "Describe how HTTPS protects a request between a browser and a server.",
    "How does garbage collection work in a language like Java or Go?",
    "What is the CAP theorem, and what does it mean in practice?",
    "Explain what a hash table is and why lookups are usually constant time.",
    "What happens when you type a URL into a browser and press enter?",
    "Compare REST and gRPC for service-to-service communication.",
]

SYSTEM = ("You are a coding agent working in a large software repository. Investigate before answering: use the tools "
          "to search the code, read files and run tests. Call exactly one tool per turn. Keep any text before a tool "
          "call to one short sentence.\n\nRepository guide:\n")
CHAT_SYSTEM = "You are a helpful assistant. Answer clearly in a few paragraphs."

FIELDS = ["condition", "mode", "cache", "sessions", "session", "turn", "ok", "error", "http_status", "backend",
          "prompt_tokens", "cached_tokens", "computed_tokens", "completion_tokens", "queue_ms", "ttft_ms", "total_ms",
          "decode_tps", "server_prompt_ms", "server_decode_ms", "tool_call", "tool_name", "t_start", "t_end", "request_id"]


@dataclass
class AgentSpec:
    gateway: str = "http://127.0.0.1:8080"
    key: str = "sk-ibench-agent"
    model: str = "qwen-fast"
    sessions: list[int] = field(default_factory=lambda: [1, 4, 8])
    turns: int = 8
    system_tokens: int = 700          # approximate size of the shared repository guide
    tool_tokens: int = 250            # approximate size of each tool result
    turn_max_tokens: int = 96         # output cap for an agent turn (a tool call is short)
    chat_max_tokens: int = 200        # output cap for a chat answer
    conditions: list[str] = field(default_factory=lambda: ["agent-cache", "agent-nocache", "chat"])
    temperature: float = 0.0
    label: str = ""


def _text(approx_tokens: int, seed: int) -> str:
    # synthetic sentences run about 8 tokens each
    return passage(max(1, approx_tokens // 8), seed=seed)


def _tool_result(name: str, args: dict, approx_tokens: int, seed: int) -> str:
    rng = random.Random(seed)
    lines = _text(approx_tokens, seed).split(". ")
    # paths and line numbers add tokens; trim to about 3.6 characters per token for this kind of text
    budget, kept = approx_tokens * 3.6, []
    for ln in lines:
        if sum(len(x) + 24 for x in kept) >= budget:
            break
        kept.append(ln)
    lines = kept
    if name == "read_file":
        path = args.get("path") or "src/module.py"
        return f"# {path}\n" + "\n".join(f"{i + 1:4d}  {ln}" for i, ln in enumerate(lines))
    if name == "run_tests":
        return "\n".join(f"tests/test_{rng.choice(['api', 'core', 'io', 'jobs'])}.py::test_{i} {'PASSED' if rng.random() > 0.15 else 'FAILED'}  {ln}"
                         for i, ln in enumerate(lines))
    return "\n".join(f"src/{rng.choice(['api', 'core', 'net', 'store', 'jobs'])}/{rng.choice(['client', 'retry', 'config', 'auth', 'cache'])}.py:{rng.randint(10, 900)}: {ln}"
                     for ln in lines)


async def _request(client: httpx.AsyncClient, spec: AgentSpec, messages: list, *, tools: bool, max_tokens: int,
                   cache: bool, tag: str) -> dict:
    """One streamed chat completion through the gateway. Returns measurements plus the assistant turn."""
    body = {"model": spec.model, "messages": messages, "max_tokens": max_tokens, "stream": True,
            "stream_options": {"include_usage": True}, "temperature": spec.temperature, "cache_prompt": cache}
    if tools:
        body["tools"] = TOOLS
    out = {"ok": False, "error": "", "http_status": 0, "content": "", "tool_calls": []}
    t0 = time.perf_counter()
    first = None
    calls: dict[int, dict] = {}
    usage, timings = {}, {}
    async with client.stream("POST", spec.gateway + "/v1/chat/completions", json=body,
                             headers={"authorization": f"Bearer {spec.key}", "x-ibench-tag": tag}) as r:
        out["http_status"] = r.status_code
        out["request_id"] = r.headers.get("x-request-id", "")
        out["backend"] = r.headers.get("x-ibench-backend", "")
        if r.status_code != 200:
            out["error"] = (await r.aread()).decode(errors="replace")[:300]
            out["total_ms"] = (time.perf_counter() - t0) * 1000
            return out
        async for line in r.aiter_lines():
            if not line.startswith("data: ") or line == "data: [DONE]":
                continue
            chunk = json.loads(line[6:])
            if chunk.get("usage"):
                usage = chunk["usage"]
                timings = chunk.get("timings") or timings
            for ch in chunk.get("choices") or []:
                d = ch.get("delta") or {}
                if (d.get("content") or d.get("tool_calls")) and first is None:
                    first = time.perf_counter()
                if d.get("content"):
                    out["content"] += d["content"]
                for tc in d.get("tool_calls") or []:
                    c = calls.setdefault(tc.get("index", 0), {"id": "", "name": "", "arguments": ""})
                    c["id"] = tc.get("id") or c["id"]
                    fn = tc.get("function") or {}
                    c["name"] += fn.get("name") or ""
                    c["arguments"] += fn.get("arguments") or ""
            if chunk.get("timings"):
                timings = chunk["timings"]
    end = time.perf_counter()
    out["tool_calls"] = [calls[i] for i in sorted(calls)]
    n_out = usage.get("completion_tokens") or 0
    cached = (usage.get("prompt_tokens_details") or {}).get("cached_tokens") or 0
    out.update(ok=True, prompt_tokens=usage.get("prompt_tokens"), cached_tokens=cached,
               computed_tokens=(usage.get("prompt_tokens") or 0) - cached, completion_tokens=n_out,
               ttft_ms=(first - t0) * 1000 if first else None, total_ms=(end - t0) * 1000,
               decode_tps=(n_out - 1) / (end - first) if first and n_out > 1 and end > first else None,
               server_prompt_ms=timings.get("prompt_ms"), server_decode_ms=timings.get("predicted_ms"))
    return out


class AgentRun:
    def __init__(self, spec: AgentSpec, on_event: Callable[[str, dict], None] | None = None):
        self.spec = spec
        self.id = time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:4]
        self.dir: Path = AGENT_DIR / self.id
        self.on_event = on_event or (lambda kind, data: None)
        self.cancelled = False
        self.rows: list[dict] = []
        self.t0 = 0.0
        self.tag = "agent-" + self.id    # marks this run's requests in the gateway's log

    # ------------------------------------------------------------------ sessions
    async def _agent_session(self, client, cond: str, n: int, s: int) -> None:
        spec, cache = self.spec, cond == "agent-cache"
        guide = _text(spec.system_tokens, seed=1)            # shared by every session: same system prompt
        messages = [{"role": "system", "content": SYSTEM + guide},
                    {"role": "user", "content": f"Ticket {self.id[-4:]}-{n}-{s}: {TASKS[s % len(TASKS)]}"}]
        for turn in range(spec.turns):
            if self.cancelled:
                return
            r = await self._send(client, messages, cond, n, s, turn, tools=True, max_tokens=spec.turn_max_tokens, cache=cache)
            if not r["ok"]:
                return
            if r["tool_calls"]:
                tc = r["tool_calls"][0]
                tc_id = tc["id"] or f"call_{s}_{turn}"
                try:
                    args = json.loads(tc["arguments"] or "{}")
                except json.JSONDecodeError:
                    args = {}
                messages.append({"role": "assistant", "content": r["content"],
                                 "tool_calls": [{"id": tc_id, "type": "function", "function": {"name": tc["name"], "arguments": tc["arguments"] or "{}"}}]})
                messages.append({"role": "tool", "tool_call_id": tc_id,
                                 "content": _tool_result(tc["name"], args, spec.tool_tokens, seed=n * 100000 + s * 1000 + turn)})
            else:
                # the model answered instead of calling a tool: keep the session going so every session has the same turns
                messages.append({"role": "assistant", "content": r["content"]})
                messages.append({"role": "user", "content": "Not done yet. Use a tool to keep investigating."})

    async def _chat_session(self, client, cond: str, n: int, s: int) -> None:
        for turn in range(self.spec.turns):
            if self.cancelled:
                return
            q = CHAT_QUESTIONS[(s + turn * 3) % len(CHAT_QUESTIONS)]
            messages = [{"role": "system", "content": CHAT_SYSTEM}, {"role": "user", "content": f"(user {self.id[-4:]}-{n}-{s}-{turn}) {q}"}]
            await self._send(client, messages, cond, n, s, turn, tools=False, max_tokens=self.spec.chat_max_tokens, cache=True)

    async def _send(self, client, messages, cond, n, s, turn, *, tools, max_tokens, cache) -> dict:
        t_start = time.perf_counter() - self.t0
        try:
            r = await _request(client, self.spec, messages, tools=tools, max_tokens=max_tokens, cache=cache, tag=self.tag)
        except httpx.HTTPError as e:
            r = {"ok": False, "error": f"{type(e).__name__}: {e}"[:300], "http_status": 0, "tool_calls": []}
        tc = r.get("tool_calls") or []
        row = {"condition": cond, "mode": "chat" if cond == "chat" else "agent", "cache": "off" if cond == "agent-nocache" else "on",
               "sessions": n, "session": s, "turn": turn, "ok": int(r["ok"]), "error": r.get("error", ""),
               "http_status": r.get("http_status", 0), "backend": r.get("backend", ""),
               "tool_call": int(bool(tc)), "tool_name": tc[0]["name"] if tc else "",
               "t_start": round(t_start, 3), "t_end": round(time.perf_counter() - self.t0, 3),
               "request_id": r.get("request_id", ""), "queue_ms": None}
        for k in ("prompt_tokens", "cached_tokens", "computed_tokens", "completion_tokens", "queue_ms", "ttft_ms", "total_ms",
                  "decode_tps", "server_prompt_ms", "server_decode_ms"):
            v = r.get(k)
            row[k] = round(v, 2) if isinstance(v, float) else v
        self.rows.append(row)
        self.on_event("agent_request", {"run": self.id, "row": row, "done": len(self.rows), "total": self.total})
        return r

    # ------------------------------------------------------------------ run
    @property
    def total(self) -> int:
        return sum(n * self.spec.turns for n in self.spec.sessions) * len(self.spec.conditions)

    async def _run(self) -> None:
        limits = httpx.Limits(max_connections=64, max_keepalive_connections=64)
        async with httpx.AsyncClient(timeout=httpx.Timeout(600, connect=10), limits=limits) as client:
            for cond in self.spec.conditions:
                for n in self.spec.sessions:
                    if self.cancelled:
                        return
                    self.on_event("agent_phase", {"run": self.id, "condition": cond, "sessions": n})
                    fn = self._chat_session if cond == "chat" else self._agent_session
                    await asyncio.gather(*(fn(client, cond, n, s) for s in range(n)))
            await self._join_queue_times(client)

    async def _join_queue_times(self, client) -> None:
        """Time to first token at the client includes waiting in the gateway's queue. The gateway logs that wait per
        request; join it in by request id so the two can be told apart."""
        try:
            r = await client.get(self.spec.gateway + "/gateway/requests", params={"tag": self.tag, "limit": 100000})
            q = {x["id"]: x.get("queue_ms") for x in r.json()}
        except (httpx.HTTPError, ValueError):
            return
        for row in self.rows:
            v = q.get(row.get("request_id"))
            row["queue_ms"] = round(v, 1) if isinstance(v, (int, float)) else None

    def run(self) -> Path:
        self.dir.mkdir(parents=True, exist_ok=True)
        meta = {"id": self.id, "kind": "agent", "label": self.spec.label, "spec": asdict(self.spec),
                "started": time.strftime("%Y-%m-%dT%H:%M:%S"), "status": "running", "total": self.total}
        (self.dir / "meta.json").write_text(json.dumps(meta, indent=2))
        self.on_event("agent_started", {"run": self.id, "total": self.total})
        self.t0 = time.perf_counter()
        status = "completed"
        try:
            asyncio.run(self._run())
            if self.cancelled:
                status = "cancelled"
        except Exception as e:  # noqa: BLE001 - record and re-raise below
            status, meta["error"] = "failed", f"{type(e).__name__}: {e}"
            raise
        finally:
            with open(self.dir / "requests.csv", "w", newline="") as f:
                w = csv.DictWriter(f, fieldnames=FIELDS)
                w.writeheader()
                for row in sorted(self.rows, key=lambda r: (self.spec.conditions.index(r["condition"]), r["sessions"], r["session"], r["turn"])):
                    w.writerow(row)
            meta.update(status=status, finished=time.strftime("%Y-%m-%dT%H:%M:%S"),
                        duration_s=round(time.perf_counter() - self.t0, 1), done=len(self.rows))
            (self.dir / "meta.json").write_text(json.dumps(meta, indent=2))
            self.on_event("agent_finished", {"run": self.id, "status": status})
        return self.dir


def list_runs() -> list[dict]:
    if not AGENT_DIR.exists():
        return []
    out = []
    for p in sorted(AGENT_DIR.glob("*/meta.json"), reverse=True):
        try:
            out.append(json.loads(p.read_text()))
        except (OSError, json.JSONDecodeError):
            continue
    return out
