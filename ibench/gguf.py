"""Read the metadata at the start of a GGUF file (architecture, layer and head counts), without loading weights.

Used to predict memory: KV cache bytes per token = 2 (key and value) × layers × KV heads × head size × bytes per
value (llama.cpp keeps the cache in f16 by default, 2 bytes).
"""

from __future__ import annotations

import struct
from functools import lru_cache
from pathlib import Path

_SCALARS = {0: "<B", 1: "<b", 2: "<H", 3: "<h", 4: "<I", 5: "<i", 6: "<f", 7: "<?", 10: "<Q", 11: "<q", 12: "<d"}


def _read(f, fmt):
    size = struct.calcsize(fmt)
    return struct.unpack(fmt, f.read(size))[0]


def _string(f) -> str:
    n = _read(f, "<Q")
    return f.read(n).decode("utf-8", errors="replace")


def _value(f, t, keep: bool):
    if t in _SCALARS:
        return _read(f, _SCALARS[t])
    if t == 8:
        return _string(f)
    if t == 9:
        it, n = _read(f, "<I"), _read(f, "<Q")
        if it in _SCALARS and not keep:            # skip big numeric arrays (token types, scores) in one seek
            f.seek(struct.calcsize(_SCALARS[it]) * n, 1)
            return n
        vals = [_value(f, it, keep) for _ in range(n)]
        return vals if keep else n                   # skipped arrays keep only their length
    raise ValueError(f"unknown GGUF value type {t}")


@lru_cache(maxsize=16)
def _metadata(path: str, mtime: float) -> dict:
    out = {}
    with open(path, "rb") as f:
        if f.read(4) != b"GGUF":
            raise ValueError("not a GGUF file")
        _read(f, "<I")                                # version
        out["tensor_count"] = _read(f, "<Q")
        for _ in range(_read(f, "<Q")):
            key = _string(f)
            t = _read(f, "<I")
            out[key] = _value(f, t, keep=not key.startswith("tokenizer.ggml."))
    return out


def model_meta(path: Path) -> dict:
    """The fields the dashboard needs, in plain names."""
    try:
        md = _metadata(str(path), path.stat().st_mtime)
    except Exception as e:
        return {"error": str(e)}
    arch = md.get("general.architecture", "")
    g = lambda k: md.get(f"{arch}.{k}")
    n_head = g("attention.head_count") or 0
    n_kv = g("attention.head_count_kv") or n_head
    embd = g("embedding_length") or 0
    layers = g("block_count") or 0
    head_dim = g("attention.key_length") or (embd // n_head if n_head else 0)
    return {
        "name": md.get("general.name"),
        "architecture": arch,
        "layers": layers,
        "embedding": embd,
        "heads": n_head,
        "kv_heads": n_kv,
        "head_dim": head_dim,
        "context_train": g("context_length"),
        "ffn": g("feed_forward_length"),
        "vocab": md.get("tokenizer.ggml.tokens"),
        "file_type": md.get("general.file_type"),
        "kv_bytes_per_token_f16": 2 * layers * n_kv * head_dim * 2,
    }
