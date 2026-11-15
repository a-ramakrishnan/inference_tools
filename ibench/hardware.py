"""Describe the machine a run happens on, so results from different machines can be compared.

No hostname or user name is recorded: results are meant to be committed to a public repo.
"""

from __future__ import annotations

import os
import platform
import re
import shutil
import subprocess

import psutil


def _run(cmd: list[str]) -> str | None:
    try:
        return subprocess.check_output(cmd, text=True, stderr=subprocess.STDOUT, timeout=10).strip()
    except Exception:
        return None


def _linux_cpu_name() -> str | None:
    out = _run(["lscpu"])
    if out:
        m = re.search(r"^Model name:\s*(.+)$", out, re.M)
        if m:
            return m.group(1).strip()
    try:
        with open("/proc/cpuinfo") as f:
            for line in f:
                if line.startswith("model name"):
                    return line.split(":", 1)[1].strip()
    except OSError:
        pass
    return None


def _gpu() -> str | None:
    if platform.system() == "Darwin" and platform.machine() == "arm64":
        return "Apple GPU (Metal)"
    if shutil.which("nvidia-smi"):
        out = _run(["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader"])
        if out:
            return out.splitlines()[0]
    return None


def llama_server_binary() -> str | None:
    return os.environ.get("LLAMA_SERVER") or shutil.which("llama-server")


def llama_cpp_version(binary: str | None = None) -> str | None:
    binary = binary or llama_server_binary()
    if not binary:
        return None
    out = _run([binary, "--version"])
    if not out:
        return None
    m = re.search(r"version:\s*(\S+)\s*\((.+?)\)", out)
    return f"{m.group(1)} ({m.group(2)})" if m else out.splitlines()[-1]


def detect() -> dict:
    system = platform.system()
    arch = platform.machine()
    physical = psutil.cpu_count(logical=False) or os.cpu_count() or 1
    logical = psutil.cpu_count(logical=True) or physical
    if system == "Darwin":
        cpu = _run(["sysctl", "-n", "machdep.cpu.brand_string"])
        p = int(_run(["sysctl", "-n", "hw.perflevel0.physicalcpu"]) or physical)
        e = int(_run(["sysctl", "-n", "hw.perflevel1.physicalcpu"]) or 0)
        os_name = f"macOS {platform.mac_ver()[0]}"
    else:
        cpu = _linux_cpu_name()
        # Linux servers (Graviton, Xeon, EPYC) have one kind of core: count them all as performance cores.
        p, e = physical, 0
        os_name = f"{system} {platform.release()}"
    mem_gb = psutil.virtual_memory().total / 2**30   # GiB, as the OS reports it
    cpu = cpu or arch
    return {
        "label": f"{cpu} · {round(mem_gb)} GB",
        "cpu": cpu,
        "arch": "arm64" if arch in ("arm64", "aarch64") else arch,
        "os": os_name,
        "performance_cores": p,
        "efficiency_cores": e,
        "physical_cores": physical,
        "logical_cores": logical,
        "memory_gb": round(mem_gb, 1),
        "gpu": _gpu(),
        "llama_cpp": llama_cpp_version(),
    }


_THERMAL_NAMES = ["nominal", "fair", "serious", "critical"]
_THERMAL_SWIFT = "import Foundation\nprint(ProcessInfo.processInfo.thermalState.rawValue)\n"


def _macos_thermal_binary() -> str | None:
    """A tiny compiled helper that prints macOS's thermal state (0-3). Built once, cached outside the repo."""
    from pathlib import Path
    cache = Path.home() / ".cache" / "ibench"
    exe = cache / "thermal-state"
    if exe.exists():
        return str(exe)
    if not shutil.which("swiftc"):
        return None
    cache.mkdir(parents=True, exist_ok=True)
    src = cache / "thermal_state.swift"
    src.write_text(_THERMAL_SWIFT)
    try:
        subprocess.run(["swiftc", "-O", str(src), "-o", str(exe)], check=True, capture_output=True, timeout=300)
    except Exception:
        return None
    return str(exe) if exe.exists() else None


def thermal_state() -> str | None:
    """macOS: nominal / fair / serious / critical (the OS's own throttling signal).
    Linux: the hottest thermal zone in °C, where the kernel exposes one (often not on cloud VMs)."""
    if platform.system() == "Darwin":
        exe = _macos_thermal_binary()
        out = _run([exe]) if exe else None
        try:
            return _THERMAL_NAMES[int(out)]
        except (TypeError, ValueError, IndexError):
            return None
    temps = []
    import glob
    for f in glob.glob("/sys/class/thermal/thermal_zone*/temp"):
        try:
            temps.append(int(open(f).read().strip()) / 1000)
        except (OSError, ValueError):
            pass
    return f"{max(temps):.0f}°C" if temps else None


THREAD_PRESETS = {
    "half_p": "Half the performance cores",
    "all_p": "All performance cores",
    "all": "All physical cores",
}


def resolve_threads(value: str | int, hw: dict) -> int:
    """Turn a preset name (half_p, all_p, all) or a number into a thread count for this machine."""
    if isinstance(value, int) or str(value).isdigit():
        return int(value)
    p, e = hw["performance_cores"], hw["efficiency_cores"]
    return {"half_p": max(1, p // 2), "all_p": p, "all": p + e}[value]
