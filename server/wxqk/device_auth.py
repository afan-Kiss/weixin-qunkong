# -*- coding: utf-8 -*-
"""Device request nonce store (replay protection)."""
from __future__ import annotations

import sqlite3
import threading
import time
from pathlib import Path

_lock = threading.RLock()
_TTL = 10 * 60


def _db(data_dir: Path) -> sqlite3.Connection:
    root = Path(data_dir) / "security"
    root.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(root / "device_nonces.sqlite3"), timeout=30)
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS device_nonces (
          device_id TEXT NOT NULL,
          nonce TEXT NOT NULL,
          created_at REAL NOT NULL,
          PRIMARY KEY (device_id, nonce)
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_nonce_created ON device_nonces(created_at)")
    return conn


def consume_nonce(data_dir: Path, device_id: str, nonce: str, now: float | None = None) -> dict:
    """Insert nonce; returns {ok, code}."""
    did = str(device_id or "").strip()
    n = str(nonce or "").strip()
    if not did or not n:
        return {"ok": False, "code": "NONCE_MISSING"}
    ts = float(now if now is not None else time.time())
    with _lock:
        conn = _db(data_dir)
        try:
            conn.execute("DELETE FROM device_nonces WHERE created_at < ?", (ts - _TTL,))
            try:
                conn.execute(
                    "INSERT INTO device_nonces(device_id, nonce, created_at) VALUES (?,?,?)",
                    (did, n, ts),
                )
                conn.commit()
            except sqlite3.IntegrityError:
                return {"ok": False, "code": "NONCE_REPLAY"}
            return {"ok": True}
        finally:
            conn.close()
