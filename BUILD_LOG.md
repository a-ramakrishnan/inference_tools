# Build log

What AI wrote, what it got wrong, and what changed. One entry per working session.

## 2026-11-15: benchmark harness and dashboard

**Built:** the `ibench` package (llama-server manager, exact-length prompt builder, async streaming load generator, sweep runner, CSV output, CLI), the FastAPI backend with live SSE progress, and the React dashboard (overview, architecture map, sweep builder, live view, results explorer, cross-machine compare).

**Reused from the earlier from-scratch project:** the TTFT and tokens/s definitions in `tinystories-ARM-model/inference.py` (`benchmark_generation`): TTFT includes prefill, decode speed counts tokens after the first. Its memory code reads PyTorch allocator counters, which don't apply to a separate llama.cpp process, so memory is measured on the server process instead.

**Corrected along the way:**
- `--no-mmap` no longer exists in llama.cpp build 12359; it was replaced by `--load-mode none`. Found from the server's start-up error, not from documentation.
- Memory was first reported in decimal GB, which made a 16 GiB machine show as "17 GB". Switched everything to GiB, including the parser for `vmmap`'s binary units.
- The live view showed the full model path, which included a home directory. llama-server now starts from the repo root with a relative path, so neither the UI nor the committed logs carry it.
- The first architecture diagram squeezed into a side column, so the text was unreadable and status labels collided with titles. It now takes the full width with the details panel underneath.

**Checked:** ibench's prefill and decode speeds against `llama-bench` on the same model and threads (121.8 vs 119.5 tok/s prefill, 51.2 vs 56.9 tok/s decode; the gap in decode is the deeper context).

**Found by measuring:** a demo sweep ran 3× slower than the first measurement. Two wrong guesses first: inherited background scheduling priority (ruled out: `llama-bench` from a plain shell was equally slow), then thermal throttling on the fanless MacBook Air (ruled out: still slow after a 3-minute cooldown, OS thermal state only "fair"). The real cause was a separate PyTorch evaluation job (`benchmarks.py` in the earlier project) running at the same time: little CPU, but it shares the unified memory bandwidth that decode depends on. A CPU-vs-GPU `llama-bench` probe made the pattern visible. The harness now records system vs server CPU per run and the OS thermal state, and re-runs the first configuration at the end to measure drift. The sweeps recorded during the contention are kept but must not be used for results.

**Added after feedback:** the architecture page gained two data-driven views. "Request lifecycle" splits real requests into waiting, prefill and decode. "Inside the worker" draws slots, KV cache and threads, and predicts memory from the GGUF header (weights + 28 KiB of KV cache per token for this model, thanks to grouped-query attention with 2 KV heads). That prediction explains 74-77% of measured peak memory; the rest grows with slot count.

**Open:** the time estimate on the sweep page is a rough model from one CPU measurement; it underestimated the 2-thread runs.

## 2026-11-15 (later): the gateway

**Built:** `ibench gateway`, an OpenAI-compatible endpoint in front of two llama.cpp servers (Q4_K_M as `qwen-fast`, Q8_0 as `qwen-quality`): API keys from a config file, routing by model name or prompt length, a concurrency limit and bounded queue per backend with 429 beyond it, streaming pass-through, a SQLite usage row per request, OpenTelemetry spans per request, a Docker Compose file, and a Gateway page in the dashboard.

**Checked before writing code:** llama-server's `/v1/chat/completions` streaming format. With `stream_options.include_usage` the last chunk carries token counts, cached tokens and server timings, so the gateway meters from the backend's own counts instead of re-tokenizing.

**Corrected along the way:**
- Streaming requests returned 500. The route reason header contained "≤", and HTTP headers must be Latin-1, so building the response raised `UnicodeEncodeError`. Reasons are now ASCII.
- Responses reported the model as the GGUF file path. llama-server now starts with `-a <model name>`, so clients see `qwen-fast`.
- The dashboard's event stream showed "offline" until the first event, because an SSE response sends no bytes until then. Both event streams now send a comment line immediately.

**Measured:** a burst of 30 simultaneous requests at the fast backend (4 running, 16 queued) served 20 and rejected 10 with 429; queue waits rose in steps of four, up to about 4.4 s.

**Compose, checked afterwards:** `docker compose up --build` on Docker Desktop (Apple Silicon). Auth, routing by name and by prompt length, streaming with usage, and the 429 behaviour all worked unchanged, and each request showed up in Jaeger as `chat.completions` with `gateway.queue`, `backend.prefill` and `backend.decode` spans. The first image build failed in `pip install` and succeeded on a plain retry, which points to a network problem rather than the Dockerfile. In the containers llama.cpp runs on the CPU, because Docker on a Mac cannot reach Metal; the same 30-request burst queued up to 18.8 s (vs 4.4 s natively with Metal) and decoded at a median of 16 tokens/s.

## 2026-11-15 (evening): agent-traffic experiment

**Built:** `ibench agent` and the Agent traffic page. A coding-agent loop (shared system prompt, three tool definitions, one task per session) runs 8 turns per session through the gateway; each turn's tool call comes from the model and the tool result is synthetic and seeded. It runs with llama.cpp's prompt cache on and off, next to a single-turn chat baseline, at 1, 4 and 8 concurrent sessions. The KV cache component on the architecture map moved from partial to built.

**Checked before writing code:** Qwen2.5-1.5B emits real OpenAI-style tool calls through llama-server (jinja templates are on by default in this build), and `cache_prompt: false` is honoured on `/v1/chat/completions`: a repeated 2,034-token prompt took 14 ms to prefill with the cache and about 1.7 s without.

**Corrected along the way:**
- Tool results were sized at 8 tokens per sentence, but file paths and line numbers roughly doubled that, so 8 turns would have overflowed the 4,096-token slots. Results are now trimmed by character count.
- At temperature 0, a later condition would have hit the cache left by an earlier one with the same task. Each conversation now carries a unique ticket line after the shared system prompt, so only the system prompt is shared across sessions, as in real traffic.
- The first full run measured time to first token at the client only, so at 8 sessions it could not separate waiting for a slot from prefill. The runner now records the gateway's request id and joins the gateway's queue time per request; the run was repeated and the first one deleted.

**Measured:** see docs/GUIDE.md. The model called a tool on only half the turns; the rest it answered in text and was told to continue. That is reported as measured rather than forced.

_Explanations of the results are written by hand, not generated._
