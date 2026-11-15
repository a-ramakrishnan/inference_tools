"""Run a grid of configurations and save the results.

One sweep = models × thread settings × prompt lengths × concurrency levels, each run `repeats` times.
The server is restarted whenever a server-level setting changes (model, threads, concurrency, GPU layers), so the
memory figure belongs to that configuration. Prompt lengths and repeats share one server, shortest prompt first.

Output, in results/<sweep id>/:
  meta.json       the spec, the machine, start/end times, status
  runs.csv        one row per run (configuration × repeat): the headline metrics
  requests.csv    one row per request
  memory.csv      server RSS samples (sweep-relative seconds)
  logs/           one llama-server log per server start
"""

from __future__ import annotations

import asyncio
import csv
import itertools
import json
import statistics
import threading
import time
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Callable

from . import MODELS_DIR, RESULTS_DIR, ROOT
from .hardware import detect, resolve_threads, thermal_state
from .loadgen import run_batch
from .prompts import PromptBuilder
from .server import LlamaServer, ServerConfig

RUN_FIELDS = [
    "sweep_id", "run_id", "machine", "arch", "model", "quant", "device", "threads_preset", "threads",
    "prompt_tokens_target", "prompt_tokens", "output_tokens", "concurrency", "repeat",
    "ttft_ms_p50", "ttft_ms_mean", "ttft_ms_max", "decode_tps_mean", "decode_tps_min", "total_tps",
    "e2e_ms_mean", "wall_s", "server_prompt_tps_mean", "server_decode_tps_mean",
    "rss_peak_gb", "mem_peak_gb", "server_load_s", "cost_per_m_tokens", "thermal", "system_cpu_pct", "server_cpu_pct", "other_cpu_pct", "errors", "timestamp",
]
REQUEST_FIELDS = ["sweep_id", "run_id", "request_index", "prompt_tokens", "output_tokens", "ttft_ms", "e2e_ms",
                  "decode_tps", "server_prompt_ms", "server_prompt_tps", "server_decode_tps", "start_offset_ms",
                  "error"]


@dataclass
class SweepSpec:
    models: list[str]                                  # GGUF file names in models/
    threads: list[str | int] = field(default_factory=lambda: ["all_p"])
    prompt_tokens: list[int] = field(default_factory=lambda: [200])
    concurrency: list[int] = field(default_factory=lambda: [1])
    repeats: int = 3
    n_predict: int = 200
    gpu_layers: int = 0                                # 0 = CPU only (the Arm vs x86 comparison); 99 = all on GPU
    hourly_cost: float | None = None                   # USD per hour, for cost per million output tokens
    cooldown_s: float = 0                              # pause between runs (fanless laptops throttle under load)
    control_run: bool = True                           # re-run the first configuration at the end to detect drift
    label: str = ""

    def runs(self) -> list[dict]:
        return [dict(model=m, threads=t, concurrency=c, prompt_tokens=p, repeat=r)
                for m, t, c, p, r in itertools.product(self.models, self.threads, self.concurrency,
                                                        sorted(self.prompt_tokens), range(1, self.repeats + 1))]


def quant_of(model_file: str) -> str:
    name = model_file.lower().removesuffix(".gguf")
    for q in ("q4_k_m", "q4_0", "q5_k_m", "q6_k", "q8_0", "f16", "bf16"):
        if name.endswith(q):
            return q.upper()
    return name.rsplit("-", 1)[-1].upper()


def list_models() -> list[dict]:
    from .gguf import model_meta
    return [{"file": p.name, "quant": quant_of(p.name), "size_gb": round(p.stat().st_size / 1e9, 2),
             "size_gib": round(p.stat().st_size / 2**30, 3), "meta": model_meta(p)}
            for p in sorted(MODELS_DIR.glob("*.gguf"))]


def _mean(xs):
    xs = [x for x in xs if x is not None]
    return round(statistics.fmean(xs), 3) if xs else None


def _read_rows(path: Path) -> list[dict]:
    if not path.exists():
        return []
    with open(path, newline="") as f:
        return list(csv.DictReader(f))


def _num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


class _CsvAppender:
    def __init__(self, path: Path, fields: list[str]):
        self.path, self.fields = path, fields
        if not path.exists():
            with open(path, "w", newline="") as f:
                csv.DictWriter(f, fields).writeheader()

    def write(self, row: dict) -> None:
        with open(self.path, "a", newline="") as f:
            csv.DictWriter(f, self.fields, extrasaction="ignore").writerow(row)


class Sweep:
    """Runs a SweepSpec. `emit(event_type, data)` receives live progress; `cancel()` stops after the current run."""

    def __init__(self, spec: SweepSpec, emit: Callable[[str, dict], None] | None = None,
                 results_dir: Path = RESULTS_DIR):
        self.spec = spec
        self.emit = emit or (lambda *_: None)
        self.id = time.strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:4]
        self.dir = results_dir / self.id
        self._cancel = threading.Event()
        self.hw = detect()
        self._t0 = time.perf_counter()

    def cancel(self) -> None:
        self._cancel.set()

    def _write_meta(self, **extra) -> dict:
        meta = {"id": self.id, "spec": asdict(self.spec), "machine": self.hw, **extra}
        path = self.dir / "meta.json"
        old = json.loads(path.read_text()) if path.exists() else {}
        old.update(meta)
        path.write_text(json.dumps(old, indent=2))
        return old

    def run(self) -> dict:
        self.dir.mkdir(parents=True, exist_ok=True)
        runs_csv = _CsvAppender(self.dir / "runs.csv", RUN_FIELDS)
        req_csv = _CsvAppender(self.dir / "requests.csv", REQUEST_FIELDS)
        mem_csv = _CsvAppender(self.dir / "memory.csv", ["t", "rss_gb", "server"])
        plan = self.spec.runs()
        meta = self._write_meta(status="running", started_at=time.strftime("%Y-%m-%dT%H:%M:%S"),
                                total_runs=len(plan), done_runs=0, thermal_at_start=thermal_state())
        self.emit("sweep_started", {"id": self.id, "total_runs": len(plan), "machine": self.hw,
                                    "spec": asdict(self.spec)})
        done, status, error = 0, "completed", None
        device = "gpu" if self.spec.gpu_layers > 0 else "cpu"
        max_prompt = max(self.spec.prompt_tokens)
        try:
            server_keys = itertools.groupby(plan, key=lambda r: (r["model"], r["threads"], r["concurrency"]))
            for n_server, ((model, threads_preset, conc), group) in enumerate(server_keys):
                if self._cancel.is_set():
                    status = "cancelled"
                    break
                group = list(group)
                threads = resolve_threads(threads_preset, self.hw)
                cfg = ServerConfig(model_path=str((MODELS_DIR / model).relative_to(ROOT)), threads=threads, parallel=conc,
                                   ctx_per_slot=max_prompt + self.spec.n_predict + 128,
                                   gpu_layers=self.spec.gpu_layers)
                server_label = f"{quant_of(model)}·t{threads}·c{conc}"

                def on_mem(t, rss, _label=server_label, _offset=time.perf_counter() - self._t0):
                    ts = round(_offset + t, 2)
                    mem_csv.write({"t": ts, "rss_gb": round(rss, 4), "server": _label})
                    self.emit("memory", {"t": ts, "rss_gb": round(rss, 4), "server": _label})

                self.emit("server_starting", {"model": model, "quant": quant_of(model), "threads": threads,
                                              "threads_preset": threads_preset, "concurrency": conc,
                                              "device": device, "args": cfg.args("llama-server", 0)[1:-2]})   # without the per-start port
                server = LlamaServer(cfg, self.dir / "logs" / f"server-{n_server:02d}-{server_label}.log",
                                     on_memory=on_mem)
                try:
                    server.start()
                    self.emit("server_ready", {"load_s": round(server.load_seconds, 2), "label": server_label})
                    builder = PromptBuilder(server.url)
                    # warm-up request, not recorded: first-call costs (thread pools, page faults) stay out of the data
                    asyncio.run(run_batch(server.url, [builder.build(32, "warmup")[0]], 8))
                    for r in group:
                        if self._cancel.is_set():
                            status = "cancelled"
                            break
                        row = self._one_run(server, builder, r, model, threads_preset, threads, device,
                                            runs_csv, req_csv)
                        done += 1
                        self._write_meta(done_runs=done)
                        self.emit("run_done", {"row": row, "done": done, "total": len(plan)})
                        if self.spec.cooldown_s and done < len(plan):
                            self.emit("cooldown", {"seconds": self.spec.cooldown_s})
                            self._cancel.wait(self.spec.cooldown_s)
                finally:
                    server.stop()
                    self.emit("server_stopped", {"label": server_label})
            if status == "completed" and self.spec.control_run and plan:
                self._control(plan[0], device, max_prompt)
        except Exception as e:
            status, error = "failed", f"{type(e).__name__}: {e}"
            self.emit("error", {"message": error})
        meta = self._write_meta(status=status, error=error, done_runs=done, thermal_at_end=thermal_state(),
                                finished_at=time.strftime("%Y-%m-%dT%H:%M:%S"),
                                duration_s=round(time.perf_counter() - self._t0, 1))
        self.emit("sweep_done", {"id": self.id, "status": status, "error": error, "done": done})
        return meta

    def _control(self, r: dict, device: str, max_prompt: int) -> None:
        """Re-run the sweep's first configuration and compare. A big change means the machine changed during the
        sweep (thermal throttling, background load), so the sweep's numbers drifted too."""
        first = next(iter(_read_rows(self.dir / "runs.csv")), None)
        if not first:
            return
        model, threads_preset = r["model"], r["threads"]
        threads = resolve_threads(threads_preset, self.hw)
        cfg = ServerConfig(model_path=str((MODELS_DIR / model).relative_to(ROOT)), threads=threads,
                           parallel=r["concurrency"], ctx_per_slot=max_prompt + self.spec.n_predict + 128,
                           gpu_layers=self.spec.gpu_layers)
        self.emit("control_started", {"run_id": first["run_id"]})
        server = LlamaServer(cfg, self.dir / "logs" / "server-control.log")
        try:
            server.start()
            builder = PromptBuilder(server.url)
            asyncio.run(run_batch(server.url, [builder.build(32, "warmup")[0]], 8))
            last = self._one_run(server, builder, {**r, "repeat": 0}, model, threads_preset, threads, device,
                                 None, None)
        finally:
            server.stop()
        drift = {}
        for k in ("ttft_ms_p50", "decode_tps_mean", "total_tps"):
            a, b = _num(first.get(k)), _num(last.get(k))
            drift[k] = round(100 * (b - a) / a, 1) if a and b else None
        control = {"run_id": first["run_id"], "first": {k: _num(first.get(k)) for k in drift},
                   "last": {k: last.get(k) for k in drift}, "drift_pct": drift,
                   "thermal_first": first.get("thermal"), "thermal_last": last.get("thermal")}
        self._write_meta(control=control)
        self.emit("control_done", control)

    def _one_run(self, server: LlamaServer, builder: PromptBuilder, r: dict, model: str, threads_preset,
                 threads: int, device: str, runs_csv: _CsvAppender | None, req_csv: _CsvAppender | None) -> dict:
        run_id = f"{quant_of(model)}-t{threads}-p{r['prompt_tokens']}-c{r['concurrency']}-r{r['repeat']}"
        prompts = [builder.build(r["prompt_tokens"], f"{self.id}-{run_id}-{i}")[0] for i in range(r["concurrency"])]
        self.emit("run_started", {"run_id": run_id, **r, "threads": threads, "quant": quant_of(model)})
        server.reset_window()

        def on_token(index, n):
            if n == 1 or n % 25 == 0:
                self.emit("token_progress", {"run_id": run_id, "request": index, "tokens": n,
                                             "of": self.spec.n_predict})

        results, wall = asyncio.run(run_batch(server.url, prompts, self.spec.n_predict, on_token))
        ok = [x for x in results if not x.error]
        for x in results:
            if req_csv:
                req_csv.write({"sweep_id": self.id, "run_id": run_id, **x.row()})
        sys_cpu, srv_cpu = server.window_cpu()
        ttfts = sorted(x.ttft_ms for x in ok)
        total_out = sum(x.output_tokens for x in ok)
        total_tps = total_out / wall if wall > 0 else None
        cost = (self.spec.hourly_cost / 3600 / total_tps * 1e6) if (self.spec.hourly_cost and total_tps) else None
        row = {
            "sweep_id": self.id, "run_id": run_id, "machine": self.hw["label"], "arch": self.hw["arch"],
            "model": model, "quant": quant_of(model), "device": device, "threads_preset": threads_preset,
            "threads": threads, "prompt_tokens_target": r["prompt_tokens"],
            "prompt_tokens": _mean([x.prompt_tokens for x in ok]), "output_tokens": _mean([x.output_tokens for x in ok]),
            "concurrency": r["concurrency"], "repeat": r["repeat"],
            "ttft_ms_p50": round(statistics.median(ttfts), 2) if ttfts else None,
            "ttft_ms_mean": _mean(ttfts), "ttft_ms_max": max(ttfts) if ttfts else None,
            "decode_tps_mean": _mean([x.decode_tps for x in ok]),
            "decode_tps_min": min((x.decode_tps for x in ok if x.decode_tps), default=None),
            "total_tps": round(total_tps, 3) if total_tps else None,
            "e2e_ms_mean": _mean([x.e2e_ms for x in ok]), "wall_s": round(wall, 3),
            "server_prompt_tps_mean": _mean([x.server_prompt_tps for x in ok]),
            "server_decode_tps_mean": _mean([x.server_decode_tps for x in ok]),
            "rss_peak_gb": round(server.window_peak_rss_gb(), 4),
            "mem_peak_gb": round(m, 4) if (m := server.lifetime_peak_gb()) else None,
            "server_load_s": round(server.load_seconds or 0, 2),
            "cost_per_m_tokens": round(cost, 4) if cost else None,
            "thermal": thermal_state(),
            "system_cpu_pct": sys_cpu, "server_cpu_pct": srv_cpu,
            "other_cpu_pct": round(max(0.0, sys_cpu - srv_cpu), 1) if sys_cpu is not None else None,
            "errors": len(results) - len(ok), "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S"),
        }
        if runs_csv:
            runs_csv.write(row)
        return row
