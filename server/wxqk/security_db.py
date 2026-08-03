# -*- coding: utf-8 -*-
"""SQLite store for 发财888 P0 security tables (commands + audit)."""
from __future__ import annotations

import sqlite3
import atexit
import threading
import time
from pathlib import Path
from typing import Any

_lock = threading.RLock()
_conn: sqlite3.Connection | None = None
_db_path: Path | None = None

SCHEMA = """
CREATE TABLE IF NOT EXISTS device_commands (
  command_id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  policy_epoch INTEGER NOT NULL DEFAULT 0,
  command_type TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  issued_at REAL NOT NULL,
  expires_at REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  delivery_count INTEGER NOT NULL DEFAULT 0,
  last_delivery_at REAL,
  received_at REAL,
  applied_at REAL,
  failed_at REAL,
  failure_reason TEXT,
  server_signature TEXT,
  client_ack_signature TEXT
);
CREATE INDEX IF NOT EXISTS idx_dc_device_status
  ON device_commands(device_id, status, issued_at);
CREATE INDEX IF NOT EXISTS idx_dc_type ON device_commands(command_type, status);

CREATE TABLE IF NOT EXISTS security_audit (
  event_id TEXT PRIMARY KEY,
  timestamp REAL NOT NULL,
  event_type TEXT NOT NULL,
  device_id TEXT,
  account_hash TEXT,
  build_id TEXT,
  policy_epoch INTEGER,
  decision_id TEXT,
  command_id TEXT,
  reason_code TEXT,
  detail_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_sa_ts ON security_audit(timestamp);
CREATE INDEX IF NOT EXISTS idx_sa_type ON security_audit(event_type);
"""


def configure(data_dir: Path) -> Path:
    global _db_path, _conn
    root = Path(data_dir) / "security"
    root.mkdir(parents=True, exist_ok=True)
    path = root / "security.db"
    with _lock:
        if _conn is not None and _db_path == path:
            return path
        if _conn is not None:
            try:
                _conn.close()
            except Exception:
                pass
        _db_path = path
        _conn = sqlite3.connect(str(path), check_same_thread=False, timeout=30)
        _conn.row_factory = sqlite3.Row
        _conn.execute("PRAGMA journal_mode=WAL")
        _conn.execute("PRAGMA synchronous=NORMAL")
        _conn.executescript(SCHEMA)
        _conn.commit()
    return path


def get_conn() -> sqlite3.Connection:
    if _conn is None:
        raise RuntimeError("security_db not configured")
    return _conn


def now_ts() -> float:
    return time.time()


def close() -> None:
    global _conn
    with _lock:
        if _conn is not None:
            try:
                _conn.close()
            except Exception:
                pass
            _conn = None


atexit.register(close)
