"""Gateway configuration from a TOML file (gateway.toml by default)."""

from __future__ import annotations

import os
import tomllib
from dataclasses import dataclass, field
from pathlib import Path

from .. import ROOT


@dataclass
class BackendConfig:
    name: str
    model: str
    gguf: str = ""
    url: str = ""
    threads: int = 4
    gpu_layers: int = 99
    slots: int = 2
    ctx_per_slot: int = 4096
    max_concurrency: int = 2
    max_queue: int = 8


@dataclass
class GatewayConfig:
    host: str = "127.0.0.1"
    port: int = 8080
    db: str = "gateway-data/usage.db"
    long_prompt_chars: int = 6000
    keys: dict[str, str] = field(default_factory=dict)      # key -> name
    backends: list[BackendConfig] = field(default_factory=list)
    otlp_endpoint: str = ""
    trace_ui_url: str = ""
    path: str = ""

    @property
    def db_path(self) -> Path:
        p = Path(self.db)
        return p if p.is_absolute() else ROOT / p


def load(path: str | Path | None = None) -> GatewayConfig:
    path = Path(path or os.environ.get("IBENCH_GATEWAY_CONFIG") or ROOT / "gateway.toml")
    raw = tomllib.loads(path.read_text())
    g = raw.get("gateway", {})
    keys = {k["key"]: k["name"] for k in raw.get("keys", [])}
    if env := os.environ.get("IBENCH_GATEWAY_KEYS"):
        keys = {}
        for pair in env.split(","):
            name, _, key = pair.partition(":")
            if key:
                keys[key.strip()] = name.strip()
    t = raw.get("tracing", {})
    return GatewayConfig(
        host=g.get("host", "127.0.0.1"), port=int(g.get("port", 8080)), db=g.get("db", "gateway-data/usage.db"),
        long_prompt_chars=int(g.get("long_prompt_chars", 6000)), keys=keys,
        backends=[BackendConfig(**b) for b in raw.get("backends", [])],
        otlp_endpoint=os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT", t.get("otlp_endpoint", "")),
        trace_ui_url=t.get("ui_url", ""), path=str(path),
    )
