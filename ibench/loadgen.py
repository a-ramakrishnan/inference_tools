"""Send N streaming requests at once to llama-server and time each one.

Definitions (client side, which is what a user feels):
  ttft_ms          request sent → first generated token received. Includes queueing and prompt processing.
  e2e_ms           request sent → last token received.
  decode_tps       tokens per second for one request after its first token: (output tokens − 1) / (last − first).
  total_tps        all output tokens of all concurrent requests / wall time from first send to last finish.

The server's own timings (prompt_ms, server_decode_tps) are kept alongside as a cross-check.

Requests use `ignore_eos` so every request produces exactly `n_predict` tokens, and `cache_prompt: false` so
every request pays for its prompt.
"""

from __future__ import annotations

import asyncio
import json
import time
from dataclasses import asdict, dataclass

import httpx


@dataclass
class RequestResult:
    request_index: int
    prompt_tokens: int
    output_tokens: int
    ttft_ms: float
    e2e_ms: float
    decode_tps: float | None
    server_prompt_ms: float | None
    server_prompt_tps: float | None
    server_decode_tps: float | None
    start_offset_ms: float     # when this request was sent, relative to the batch start
    error: str | None = None

    def row(self) -> dict:
        return asdict(self)


async def _one(client: httpx.AsyncClient, url: str, index: int, prompt: str, n_predict: int, t_batch: float,
               on_token=None) -> RequestResult:
    payload = {"prompt": prompt, "n_predict": n_predict, "stream": True, "ignore_eos": True,
               "cache_prompt": False, "temperature": 0.0, "seed": 1234}
    t0 = time.perf_counter()
    first = last = None
    n = 0
    final: dict = {}
    try:
        async with client.stream("POST", url + "/completion", json=payload, timeout=None) as r:
            r.raise_for_status()
            async for line in r.aiter_lines():
                if not line.startswith("data: "):
                    continue
                data = json.loads(line[6:])
                if data.get("stop"):
                    final = data
                    break
                now = time.perf_counter()
                k = len(data.get("tokens") or []) or 1
                n += k
                if first is None:
                    first = now
                last = now
                if on_token:
                    on_token(index, n)
    except Exception as e:  # keep the run going; the row records what failed
        return RequestResult(index, 0, n, 0, (time.perf_counter() - t0) * 1000, None, None, None, None,
                             (t0 - t_batch) * 1000, error=f"{type(e).__name__}: {e}")
    timings = final.get("timings", {})
    out = timings.get("predicted_n", n)
    decode = (out - 1) / (last - first) if first and last and last > first and out > 1 else None
    return RequestResult(
        request_index=index,
        prompt_tokens=timings.get("prompt_n", final.get("tokens_evaluated", 0)),
        output_tokens=out,
        ttft_ms=round(((first or time.perf_counter()) - t0) * 1000, 2),
        e2e_ms=round(((last or time.perf_counter()) - t0) * 1000, 2),
        decode_tps=round(decode, 3) if decode else None,
        server_prompt_ms=timings.get("prompt_ms"),
        server_prompt_tps=timings.get("prompt_per_second"),
        server_decode_tps=timings.get("predicted_per_second"),
        start_offset_ms=round((t0 - t_batch) * 1000, 2),
    )


async def run_batch(url: str, prompts: list[str], n_predict: int, on_token=None) -> tuple[list[RequestResult], float]:
    """All prompts at once. Returns the per-request results and the wall time in seconds."""
    limits = httpx.Limits(max_connections=len(prompts) + 2, max_keepalive_connections=len(prompts) + 2)
    async with httpx.AsyncClient(limits=limits) as client:
        t_batch = time.perf_counter()
        results = await asyncio.gather(*[_one(client, url, i, p, n_predict, t_batch, on_token)
                                         for i, p in enumerate(prompts)])
        wall = time.perf_counter() - t_batch
    return list(results), wall
