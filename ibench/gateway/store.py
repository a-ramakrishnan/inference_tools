"""The usage table: one row per request through the gateway, in SQLite.

It holds what usage accounting needs (API key name, model, input and output tokens, time) and what a trace needs
(queue wait, time to first token, generation time), so the dashboard can draw both without a tracing backend.
API keys themselves are never stored, only their names.
"""

from __future__ import annotations

import sqlite3
import threading
import time
from pathlib import Path

COLUMNS = [
    ("id", "TEXT PRIMARY KEY"), ("trace_id", "TEXT"), ("ts", "REAL"), ("key_name", "TEXT"),
    ("model_requested", "TEXT"), ("model", "TEXT"), ("backend", "TEXT"), ("route_reason", "TEXT"),
    ("stream", "INTEGER"), ("status", "TEXT"), ("http_status", "INTEGER"),
    ("prompt_tokens", "INTEGER"), ("completion_tokens", "INTEGER"), ("cached_tokens", "INTEGER"),
    ("queue_ms", "REAL"), ("ttft_ms", "REAL"), ("gen_ms", "REAL"), ("total_ms", "REAL"),
    ("decode_tps", "REAL"), ("server_prompt_ms", "REAL"), ("tag", "TEXT"), ("error", "TEXT"),
]
NAMES = [c for c, _ in COLUMNS]


class Store:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.lock = threading.Lock()
        with self.lock:
            self.db.execute(f"CREATE TABLE IF NOT EXISTS requests ({', '.join(f'{c} {t}' for c, t in COLUMNS)})")
            have = {r[1] for r in self.db.execute("PRAGMA table_info(requests)")}
            for c, t in COLUMNS:                       # add columns introduced after the table was created
                if c not in have:
                    self.db.execute(f"ALTER TABLE requests ADD COLUMN {c} {t.split()[0]}")
            self.db.execute("CREATE INDEX IF NOT EXISTS requests_ts ON requests(ts)")
            self.db.commit()

    def insert(self, row: dict) -> None:
        vals = [row.get(c) for c in NAMES]
        with self.lock:
            self.db.execute(f"INSERT OR REPLACE INTO requests ({', '.join(NAMES)}) VALUES ({', '.join('?' * len(NAMES))})", vals)
            self.db.commit()

    def recent(self, limit: int = 200, tag: str | None = None) -> list[dict]:
        q = "SELECT * FROM requests" + (" WHERE tag = ?" if tag else "") + " ORDER BY ts DESC LIMIT ?"
        with self.lock:
            return [dict(r) for r in self.db.execute(q, (tag, limit) if tag else (limit,))]

    def usage(self, group: str = "key_name", since: float | None = None) -> list[dict]:
        if group not in ("key_name", "model", "backend", "day"):
            raise ValueError("group must be key_name, model, backend or day")
        g = "strftime('%Y-%m-%d', ts, 'unixepoch')" if group == "day" else group
        where = "WHERE ts >= ?" if since else ""
        q = f"""SELECT {g} AS grp, COUNT(*) AS requests,
                       SUM(status = 'ok') AS ok, SUM(status = 'rejected') AS rejected,
                       SUM(status NOT IN ('ok', 'rejected')) AS errors,
                       COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
                       COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
                       COALESCE(SUM(cached_tokens), 0) AS cached_tokens,
                       AVG(ttft_ms) AS ttft_ms_mean, AVG(queue_ms) AS queue_ms_mean, MAX(ts) AS last_ts
                FROM requests {where} GROUP BY grp ORDER BY completion_tokens DESC"""
        with self.lock:
            rows = [dict(r) for r in self.db.execute(q, (since,) if since else ())]
            for r in rows:                              # p95 TTFT per group (SQLite has no percentile)
                col = "strftime('%Y-%m-%d', ts, 'unixepoch')" if group == "day" else group
                ts = [x[0] for x in self.db.execute(
                    f"SELECT ttft_ms FROM requests WHERE {col} IS ? AND ttft_ms IS NOT NULL {('AND ts >= ?' if since else '')} ORDER BY ttft_ms",
                    (r["grp"], since) if since else (r["grp"],))]
                r["ttft_ms_p95"] = ts[min(len(ts) - 1, int(0.95 * len(ts)))] if ts else None
        return rows

    def all_rows(self) -> list[dict]:
        with self.lock:
            return [dict(r) for r in self.db.execute("SELECT * FROM requests ORDER BY ts")]


def now() -> float:
    return time.time()
