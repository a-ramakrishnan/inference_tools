# ibench: full guide

**Measure LLM inference the way a platform team would:** time to first token, tokens per second and memory for a small open model served by [llama.cpp](https://github.com/ggml-org/llama.cpp), swept across quantization, threads, prompt length and concurrency, on Arm and x86. A React dashboard runs the sweeps, streams them live, charts the results and maps the work onto a reference inference-platform architecture.

- **Real runs only.** Every number comes from a `llama-server` process started for that configuration and is saved to CSV. The harness agrees with llama.cpp's own `llama-bench` to within a few percent (see [Validation](#validation)).
- **Headless or with a UI.** The same sweep runs from the CLI on a cloud instance or in Colab, and its results folder drops into the dashboard for side-by-side comparison.
- **Honest scope.** The architecture page marks each component *built*, *partial*, *next* or *out of scope*.

## Quick start

Requirements: Python 3.11+, Node 18+, llama.cpp (`llama-server` on PATH, or set `LLAMA_SERVER`).

```bash
brew install llama.cpp          # or build from source on Linux, see below
```

```bash
mkdir -p models
for q in q4_k_m q8_0; do
  curl -L -o models/qwen2.5-1.5b-instruct-$q.gguf \
    https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-$q.gguf
done
```

```bash
uv venv && uv pip install -e .          # or: python -m venv .venv && .venv/bin/pip install -e .
```

```bash
cd web && npm install && npm run build && cd ..
```

```bash
.venv/bin/ibench serve                  # dashboard on http://127.0.0.1:8000
```

For front-end development, run `ibench serve` and `npm --prefix web run dev` together (Vite on :5173 proxies `/api` to :8000).

### CLI

```bash
ibench info                                  # machine, llama.cpp version, models found
ibench run --preset smoke                    # one configuration, under a minute
ibench run --preset laptop                   # the full grid (hours on CPU)
ibench run --preset cloud --hourly-cost 0.34 # 4-bit subset, with cost per 1M tokens
ibench run --models qwen2.5-1.5b-instruct-q4_k_m.gguf --threads 4,8 --prompt 200,4000 --concurrency 1,4,8 --repeats 3
```

Presets live in [ibench/presets.py](../ibench/presets.py).

```bash
ibench agent                                 # agent vs chat traffic through a running gateway
ibench agent --sessions 1,4 --turns 6 --tool-tokens 200 --conditions agent-cache,agent-nocache
```

## What a run measures

Each run sends `concurrency` streaming requests at the same moment. Each request has its own prompt of an exact token length and generates exactly `n_predict` tokens (`ignore_eos`), with prompt caching off so every request pays for its prompt.

| Metric | Definition |
| --- | --- |
| Time to first token (`ttft_ms_*`) | Request sent → first generated token received by the client. Includes queueing and prompt processing. p50, mean and max across the concurrent requests. |
| Tokens/s per request (`decode_tps_mean`) | One request's decode speed after its first token: (output tokens − 1) / (last token − first token). |
| Total tokens/s (`total_tps`) | All output tokens of all concurrent requests ÷ wall time from first send to last token. |
| Peak memory (`mem_peak_gb`) | The OS's own peak physical memory for the `llama-server` process, in GiB: "Physical footprint (peak)" from `vmmap` on macOS, `VmHWM` on Linux. Weights load without mmap so they are counted. |
| Sampled RSS (`rss_peak_gb`) | Peak resident memory sampled every 100 ms during the run. |
| Prefill speed (`server_prompt_tps_mean`) | llama.cpp's own prompt-processing timing, a cross-check on TTFT. |
| Cost per 1M output tokens | Instance $/hour ÷ 3600 ÷ total tokens/s × 10⁶, when a price is given. |
| CPU contention (`system_cpu_pct`, `server_cpu_pct`, `other_cpu_pct`) | Average CPU use over the run, as a share of all cores: the whole machine, llama-server, and the difference. |
| Thermal state (`thermal`) | After each run: macOS's own thermal state (nominal, fair, serious, critical), or the hottest thermal zone in °C on Linux where the kernel exposes one. |

The server restarts whenever the model, threads, concurrency or device changes. Each slot's KV cache is sized for the longest prompt plus output, so memory reflects that configuration.

## Keeping the machine quiet

A CPU benchmark measures everything else the machine is doing too. While building this, a demo sweep ran three times slower than the first measurement: `llama-bench` itself dropped from 119.5 to 37.9 tok/s prefill and from 56.9 to 19.5 tok/s decode. The cause was a separate PyTorch evaluation job that had started on the same Mac. It used little CPU, but on Apple Silicon the GPU and CPU share one memory system, and token generation is limited by memory bandwidth.

So ibench records, for every run:

- system-wide CPU use and `llama-server`'s own share; the gap (`other_cpu_pct`) is everything else;
- the operating system's thermal state, since fanless laptops throttle under sustained load;
- and, at the end of a sweep, a **control run** that repeats the first configuration. The Results page flags the sweep when decode speed drifted more than 10%, whatever the cause, including GPU contention that CPU numbers can't see.

A cooldown between runs is also available. Close other heavy work before a sweep you plan to publish.

## Output

Each sweep writes `results/<sweep id>/`:

| File | Contents |
| --- | --- |
| `meta.json` | The grid, the machine (CPU, cores, memory, GPU, llama.cpp build; no hostname), timing, status |
| `runs.csv` | One row per run (configuration × repeat) with the metrics above |
| `requests.csv` | One row per request: TTFT, end-to-end time, decode speed, server timings, start offset |
| `memory.csv` | Server RSS samples across the sweep |
| `logs/` | One `llama-server` log per server start |

## The dashboard

| Page | What it does |
| --- | --- |
| Overview | Headline numbers from the latest sweep, the machine, the models, recent sweeps |
| Architecture | A reference LLM inference platform with each component marked by how far this repo builds it; click a box for details |
| New sweep | Presets or a custom grid, with a run count and a time estimate |
| Live | Progress, the running server's command line, per-request token progress, live memory, completed runs, event log |
| Results | Key charts (TTFT, per-request and total throughput, memory, thread scaling), a chart explorer, a sortable table, per-request timelines, memory over the sweep, CSV downloads |
| Compare | Sweeps from different machines side by side; import a zipped results folder |
| Agent traffic | Runs the agent-traffic experiment; time to first token by turn, prefill cost per turn (reused vs computed), sessions vs slots, and a summary table |
| Gateway | Backend status (in flight, queued), a streaming playground, a burst traffic generator with per-request queue/prefill/decode lanes, a live request log, and the per-key usage report |

## The gateway

`ibench gateway` starts an OpenAI-compatible endpoint at `http://127.0.0.1:8080/v1` and the two llama.cpp servers behind it, configured in [`gateway.toml`](../gateway.toml):

| Backend | Model name | Weights | Concurrency limit | Queue limit |
| --- | --- | --- | --- | --- |
| fast | `qwen-fast` | Q4_K_M | 4 | 16 |
| quality | `qwen-quality` | Q8_0 | 2 | 8 |

- **Auth:** `Authorization: Bearer <key>`; keys and their names are in `gateway.toml` (demo keys `sk-ibench-demo`, `sk-ibench-agent`, `sk-ibench-batch`) or in `IBENCH_GATEWAY_KEYS="name:key,..."`. Unknown key → 401.
- **Routing:** by `model`. `model: "auto"` estimates prompt tokens as characters ÷ 4 and sends prompts above `long_prompt_chars` to the backend with the larger context. The response headers `x-ibench-backend` and `x-ibench-route` say where a request went and why.
- **Queueing:** each backend admits up to its concurrency limit and holds up to its queue limit waiting; beyond that the gateway answers 429. Queue wait is returned in `x-ibench-queue-ms` and stored per request.
- **Usage:** every request writes a row to `gateway-data/usage.db` (key, model, backend, input/output/cached tokens, queue wait, TTFT, decode speed, status). `GET /gateway/usage?group=key_name|model|backend|day` and `/gateway/usage.csv`.
- **Tracing:** with `[tracing] otlp_endpoint` set (or `OTEL_EXPORTER_OTLP_ENDPOINT`), each request becomes an OpenTelemetry trace with `gateway.queue`, `backend.prefill` and `backend.decode` spans, built from the measured timestamps. `otlp_endpoint = "console"` prints them. Needs `pip install -e '.[tracing]'`.

```bash
curl -N http://127.0.0.1:8080/v1/chat/completions \
  -H "Authorization: Bearer sk-ibench-demo" -H "Content-Type: application/json" \
  -d '{"model":"auto","stream":true,"messages":[{"role":"user","content":"Hello"}]}'
```

Any OpenAI SDK works with `base_url="http://127.0.0.1:8080/v1"`.

**Docker Compose:** `docker compose up --build` runs both llama.cpp servers (`ghcr.io/ggml-org/llama.cpp:server`, CPU), the gateway and Jaeger (traces at http://127.0.0.1:16686), using [`gateway.docker.toml`](../gateway.docker.toml). The GGUF files must already be in `models/`. Checked on an M5 MacBook Air with Docker Desktop: auth, both routing paths, streaming with usage, 429s under a burst, and one trace per request in Jaeger. Inside Docker on a Mac, llama.cpp runs on the CPU (no Metal), so the same 30-request burst queued up to 18.8 s and decoded at a median of 16 tokens/s; use `ibench gateway` for speed on a Mac.

The benchmark sweeps do not go through the gateway: the load generator talks to llama-server directly, so gateway overhead never enters the engine numbers.

## Agent traffic

`ibench agent` compares two kinds of traffic through the gateway, against the same llama.cpp backend (`qwen-fast` by default):

- **Agent:** a shared system prompt with three tool definitions (`search_code`, `read_file`, `run_tests`) and one task per session. Each turn the model is asked to call a tool; its tool call is real, the tool result is synthetic (seeded, about `--tool-tokens` tokens) and is appended, and the whole conversation is sent again. If the model answers in text instead, it is told to continue, so every session has the same number of turns. Run twice: with llama.cpp's prompt cache on (its default) and off (`cache_prompt: false`).
- **Chat:** independent single-turn questions, short prompt, answers capped at 200 tokens.

Each condition runs with 1, 4 and 8 concurrent sessions (`--sessions`). Every request is one row in `results/agent/<id>/requests.csv`: prompt, cached and computed tokens, output tokens, time to first token at the client, the gateway's queue wait for that request (joined by request id), decode speed and whether the model called a tool. Keep the final context under the backend's context per slot (4,096 tokens for `qwen-fast`): roughly 1,400 + turns × (tool tokens + 100).

First run (M5 MacBook Air, `qwen-fast` on Metal, 8 turns, 312 requests, all succeeded):

| | 1 session | 4 sessions | 8 sessions |
| --- | --- | --- | --- |
| Agent, cache on: TTFT p50 (of which queued) | 170 ms (0) | 308 ms (0) | 3.42 s (2.73 s) |
| Agent, cache off: TTFT p50 (of which queued) | 1.29 s (0) | 1.61 s (0) | 7.29 s (5.13 s) |
| Chat: TTFT p50 (of which queued) | 71 ms (0) | 203 ms (0) | 4.58 s (4.43 s) |
| Agent, cache on: prompt tokens reused | 94% | 94% | 69% |

Agent requests carried 34–46 prompt tokens per output token; chat requests 0.26. The model called a tool on 50% of agent turns.

## Running on other machines

Run the same preset on each machine, then bring the folders together.

**Colab (x86):** open [notebooks/colab_x86.ipynb](../notebooks/colab_x86.ipynb) in Colab ([open directly](https://colab.research.google.com/github/a-ramakrishnan/inference_tools/blob/main/notebooks/colab_x86.ipynb)), pick a CPU runtime, and run all cells. It builds llama.cpp from tag `b12359` (the same build as the laptop runs), downloads the 4-bit model, runs a smoke test and the `cloud` preset, and downloads a zip of the results for the Compare page. A free CPU runtime has one physical core; a High-RAM CPU runtime has more. Colab has no hourly price, so cost per million tokens is left out unless you set one.

**Other Linux machines:**

```bash
# on the cloud instance (Ubuntu): build llama.cpp, then the same steps as above
git clone https://github.com/ggml-org/llama.cpp && cmake -S llama.cpp -B llama.cpp/build -DCMAKE_BUILD_TYPE=Release && cmake --build llama.cpp/build -j --target llama-server
export LLAMA_SERVER=$PWD/llama.cpp/build/bin/llama-server
ibench run --preset cloud --hourly-cost <price>
```

```bash
cd results && zip -r <sweep id>.zip <sweep id>     # then: Compare → Import results zip
```

On Linux every physical core counts as a performance core, so `all_p` and `all` are the same there.

An Arm server (for example AWS Graviton) has not been run: there is no AWS account for this project. The Arm side of the comparison is the Apple Silicon laptop.

## Validation

On an Apple M5 (4 performance cores, CPU only, Q4_K_M, 4 threads), for a 200-token prompt:

| | Prefill tok/s | Decode tok/s |
| --- | ---: | ---: |
| `llama-bench -p 200 -n 64` | 119.5 | 56.9 |
| ibench (client side) | 121.8 | 51.2 |

The decode figure is a little lower in ibench because it decodes after a 200-token prompt, not from an empty context.

## Layout

```
ibench/            Python package: hardware detection, llama-server manager, prompt builder,
                   load generator, sweep runner, CLI, FastAPI app
ibench/gateway/    OpenAI-compatible gateway: auth, routing, queue, usage store, tracing
ibench/agent.py    Agent-traffic experiment (tool-calling loop, chat baseline)
gateway.toml       Gateway keys and backends (gateway.docker.toml for Compose)
compose.yaml       Two llama.cpp servers + gateway + Jaeger
web/               React + TypeScript + Vite dashboard (Recharts)
results/           Sweep outputs and results/agent/ runs (committed)
models/            GGUF weights (not committed)
notebooks/         Colab notebook for the x86 runs
PLAN.md            Project plan
BUILD_LOG.md       What AI got right and wrong while building this
```

## License

MIT
