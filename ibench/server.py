"""Start, watch and stop one llama-server process.

Memory is measured on the server process in GiB (2^30 bytes), two ways:
  rss      resident set size, sampled every 100 ms while a run is in progress (peak kept per run window)
  peak     the operating system's own peak for the whole process lifetime: "Physical footprint (peak)" from
           vmmap on macOS, VmHWM from /proc on Linux. It does not miss short spikes the sampler can miss.

The model is loaded with `--load-mode none` (no mmap). With mmap the weights are clean file-backed pages, which
macOS leaves out of the physical footprint, so memory would be under-reported.
"""

from __future__ import annotations

import os
import platform
import re
import signal
import socket
import subprocess
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

import httpx
import psutil

from . import ROOT
from .hardware import llama_server_binary


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@dataclass
class ServerConfig:
    model_path: str
    threads: int
    parallel: int          # server slots = the concurrency the server will see
    ctx_per_slot: int      # tokens each slot can hold (prompt + output)
    gpu_layers: int = 0    # 0 = CPU only, 99 = everything on the GPU
    flash_attn: str = "auto"
    alias: str = ""        # model name llama-server reports (the gateway's client-facing name)

    def args(self, binary: str, port: int) -> list[str]:
        return [
            binary, "-m", self.model_path,
            "-t", str(self.threads), "-tb", str(self.threads),
            "-c", str(self.ctx_per_slot * self.parallel), "-np", str(self.parallel),
            "-ngl", str(self.gpu_layers), "-fa", self.flash_attn,
            "-lm", "none", "--no-webui", "--metrics",
            *(["-a", self.alias] if self.alias else []),
            "--host", "127.0.0.1", "--port", str(port),
        ]


@dataclass
class LlamaServer:
    config: ServerConfig
    log_path: Path
    on_memory: Callable[[float, float], None] | None = None   # (seconds since start, rss GB)
    sample_interval: float = 0.1

    port: int = 0
    proc: subprocess.Popen | None = None
    load_seconds: float | None = None
    _ps: psutil.Process | None = None
    _stop: threading.Event = field(default_factory=threading.Event)
    _thread: threading.Thread | None = None
    _window_peak: float = 0.0
    _cpu_sys: list = field(default_factory=list)     # system-wide CPU %, all cores = 100
    _cpu_srv: list = field(default_factory=list)     # llama-server CPU %, as a share of all cores
    _t0: float = 0.0
    samples: list[tuple[float, float]] = field(default_factory=list)

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def start(self, timeout: float = 180) -> None:
        binary = llama_server_binary()
        if not binary:
            raise RuntimeError("llama-server not found. Install llama.cpp (brew install llama.cpp) or set LLAMA_SERVER.")
        self.port = free_port()
        self.log_path.parent.mkdir(parents=True, exist_ok=True)
        log = open(self.log_path, "w")
        self._t0 = time.perf_counter()
        self.proc = subprocess.Popen(self.config.args(binary, self.port), stdout=log, stderr=subprocess.STDOUT,
                                     start_new_session=True, cwd=ROOT)   # relative model path: no home dir in logs
        self._ps = psutil.Process(self.proc.pid)
        self._thread = threading.Thread(target=self._sample, daemon=True)
        self._thread.start()
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self.proc.poll() is not None:
                raise RuntimeError(f"llama-server exited during start-up:\n{self.tail_log()}")
            try:
                if httpx.get(self.url + "/health", timeout=1).status_code == 200:
                    self.load_seconds = time.perf_counter() - self._t0
                    return
            except httpx.HTTPError:
                pass
            time.sleep(0.25)
        self.stop()
        raise RuntimeError(f"llama-server did not become ready in {timeout:.0f}s:\n{self.tail_log()}")

    def _sample(self) -> None:
        ncpu = psutil.cpu_count() or 1
        psutil.cpu_percent(None)
        try:
            self._ps.cpu_percent(None)
        except psutil.Error:
            pass
        while not self._stop.is_set():
            try:
                rss = self._ps.memory_info().rss / 2**30
                self._cpu_srv.append(self._ps.cpu_percent(None) / ncpu)
                self._cpu_sys.append(psutil.cpu_percent(None))
            except (psutil.Error, AttributeError):
                return
            t = time.perf_counter() - self._t0
            self.samples.append((t, rss))
            self._window_peak = max(self._window_peak, rss)
            if self.on_memory:
                self.on_memory(t, rss)
            self._stop.wait(self.sample_interval)

    def reset_window(self) -> None:
        self._window_peak = 0.0
        self._cpu_sys, self._cpu_srv = [], []

    def window_cpu(self) -> tuple[float | None, float | None]:
        """(system-wide CPU %, llama-server CPU %) averaged over the run window. Their gap is other work."""
        if not self._cpu_sys:
            return None, None
        return (round(sum(self._cpu_sys) / len(self._cpu_sys), 1), round(sum(self._cpu_srv) / len(self._cpu_srv), 1))

    def window_peak_rss_gb(self) -> float:
        return self._window_peak

    def lifetime_peak_gb(self) -> float | None:
        """The OS's own peak memory figure for the server process."""
        if not self.proc:
            return None
        pid = self.proc.pid
        if platform.system() == "Darwin":
            try:
                out = subprocess.check_output(["vmmap", "--summary", str(pid)], text=True, stderr=subprocess.DEVNULL,
                                              timeout=20)
            except Exception:
                return None
            m = re.search(r"Physical footprint \(peak\):\s*([\d.]+)([KMG])", out)
            if not m:
                return None
            return float(m.group(1)) / {"K": 2**20, "M": 2**10, "G": 1}[m.group(2)]   # vmmap units are binary
        try:
            with open(f"/proc/{pid}/status") as f:
                for line in f:
                    if line.startswith("VmHWM:"):
                        return int(line.split()[1]) / 2**20   # kB → GiB
        except OSError:
            return None
        return None

    def tail_log(self, n: int = 30) -> str:
        try:
            return "\n".join(self.log_path.read_text(errors="replace").splitlines()[-n:])
        except OSError:
            return ""

    def stop(self) -> None:
        self._stop.set()
        if self.proc and self.proc.poll() is None:
            try:
                os.killpg(self.proc.pid, signal.SIGTERM)
                self.proc.wait(timeout=15)
            except Exception:
                try:
                    os.killpg(self.proc.pid, signal.SIGKILL)
                except Exception:
                    pass
        if self._thread:
            self._thread.join(timeout=2)

    def __enter__(self):
        self.start()
        return self

    def __exit__(self, *exc):
        self.stop()
