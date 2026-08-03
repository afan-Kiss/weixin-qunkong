# -*- coding: utf-8 -*-
"""SQLite analytics database for formula events, road boots, and backtest cache."""
from __future__ import annotations

import sqlite3
import atexit
import threading
import time
from pathlib import Path
from typing import Any, Iterator

from analytics_versions import DATA_SCHEMA_VERSION

_lock = threading.RLock()
_conn: sqlite3.Connection | None = None
_db_path: Path | None = None

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS formula_events (
  event_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  algorithm_version TEXT NOT NULL,
  occurred_at INTEGER,
  uploaded_at INTEGER NOT NULL,
  client_id TEXT,
  account_hash TEXT,
  masked_account TEXT,
  ip TEXT,
  formula_id TEXT,
  pattern_text TEXT,
  pattern_hash TEXT,
  slot INTEGER DEFAULT 0,
  bet_transaction_id TEXT,
  code TEXT NOT NULL,
  simulated INTEGER NOT NULL DEFAULT 0,
  table_id INTEGER,
  table_title TEXT,
  category TEXT,
  boot_no TEXT,
  round_id INTEGER,
  shoe_id TEXT,
  bet_side TEXT,
  bet_point_id INTEGER,
  bet_amount REAL,
  game_result TEXT,
  net_profit REAL,
  payout_ratio REAL,
  settlement_source TEXT,
  settlement_confidence TEXT,
  unknown_reason TEXT,
  source TEXT DEFAULT 'live'
);

CREATE TABLE IF NOT EXISTS road_boots (
  day TEXT NOT NULL,
  table_id INTEGER NOT NULL,
  boot_no TEXT NOT NULL,
  title TEXT,
  game_type_id INTEGER,
  category TEXT,
  seq TEXT,
  pairs TEXT,
  seq_len INTEGER DEFAULT 0,
  seq_hash TEXT,
  first_seen_at INTEGER,
  updated_at INTEGER,
  source_client_count INTEGER DEFAULT 0,
  consensus_client_count INTEGER DEFAULT 0,
  continuity_ok INTEGER DEFAULT 0,
  geometry_verified INTEGER DEFAULT 0,
  classification_verified INTEGER DEFAULT 0,
  quality_level TEXT DEFAULT 'C',
  quality_reasons TEXT,
  schema_version INTEGER,
  algorithm_version TEXT,
  PRIMARY KEY(day, table_id, boot_no)
);

CREATE TABLE IF NOT EXISTS road_updates (
  update_id TEXT PRIMARY KEY,
  day TEXT,
  table_id INTEGER,
  boot_no TEXT,
  client_id TEXT,
  account_hash TEXT,
  mode TEXT,
  from_index INTEGER,
  add_seq TEXT,
  full_seq_hash TEXT,
  previous_seq_hash TEXT,
  current_seq_hash TEXT,
  current_seq_len INTEGER,
  observed_at INTEGER,
  received_at INTEGER,
  accepted INTEGER,
  reject_reason TEXT
);

CREATE TABLE IF NOT EXISTS backtest_runs (
  cache_key TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  dataset_hash TEXT,
  formula_hash TEXT,
  plan_hash TEXT,
  algorithm_version TEXT,
  filters_json TEXT,
  result_json TEXT
);

CREATE TABLE IF NOT EXISTS road_client_hashes (
  day TEXT NOT NULL,
  table_id INTEGER NOT NULL,
  boot_no TEXT NOT NULL,
  seq_len INTEGER NOT NULL,
  client_id TEXT NOT NULL,
  seq_hash TEXT NOT NULL,
  updated_at INTEGER,
  PRIMARY KEY(day, table_id, boot_no, seq_len, client_id)
);

CREATE INDEX IF NOT EXISTS idx_fe_formula ON formula_events(formula_id, slot, simulated, occurred_at);
CREATE INDEX IF NOT EXISTS idx_fe_client ON formula_events(client_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_fe_account ON formula_events(account_hash, occurred_at);
CREATE INDEX IF NOT EXISTS idx_fe_tx ON formula_events(bet_transaction_id);
CREATE INDEX IF NOT EXISTS idx_fe_code ON formula_events(code, occurred_at);
CREATE INDEX IF NOT EXISTS idx_rb_day ON road_boots(day, category, quality_level);
CREATE INDEX IF NOT EXISTS idx_rb_table ON road_boots(table_id, day);
CREATE INDEX IF NOT EXISTS idx_ru_boot ON road_updates(day, table_id, boot_no);
CREATE INDEX IF NOT EXISTS idx_bt_exp ON backtest_runs(expires_at);
"""


def configure(data_dir: Path) -> Path:
    """Set analytics root under SIREN_DATA/analytics."""
    global _db_path
    root = Path(data_dir) / "analytics"
    root.mkdir(parents=True, exist_ok=True)
    _db_path = root / "analytics.db"
    return _db_path


def get_conn() -> sqlite3.Connection:
    """Shared writer connection. All use MUST be under analytics_db._lock."""
    global _conn
    with _lock:
        if _conn is None:
            if _db_path is None:
                raise RuntimeError("analytics_db.configure() not called")
            _conn = sqlite3.connect(str(_db_path), check_same_thread=False, timeout=30)
            _conn.row_factory = sqlite3.Row
            _conn.execute("PRAGMA journal_mode=WAL;")
            _conn.execute("PRAGMA synchronous=NORMAL;")
            _conn.execute("PRAGMA busy_timeout=5000;")
            _conn.execute("PRAGMA foreign_keys=ON;")
            _conn.executescript(SCHEMA_SQL)
            _conn.commit()
            _set_meta("data_schema_version", str(DATA_SCHEMA_VERSION))
        return _conn


def open_readonly() -> sqlite3.Connection:
    """Short-lived read connection (caller must close). Safe across threads."""
    if _db_path is None:
        raise RuntimeError("analytics_db.configure() not called")
    # Ensure schema exists first.
    get_conn()
    conn = sqlite3.connect(f"file:{_db_path}?mode=ro", uri=True, check_same_thread=False, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout=5000;")
    return conn


def integrity_check() -> str:
    with _lock:
        conn = get_conn()
        row = conn.execute("PRAGMA integrity_check").fetchone()
        return str(row[0]) if row else "fail"


def db_path() -> Path | None:
    return _db_path


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


def _set_meta(key: str, value: str) -> None:
    conn = get_conn()
    conn.execute(
        "INSERT INTO meta(key,value,updated_at) VALUES(?,?,?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
        (key, value, int(time.time())),
    )
    conn.commit()


def get_meta(key: str, default: str = "") -> str:
    conn = get_conn()
    row = conn.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
    return str(row["value"]) if row else default


def set_meta(key: str, value: str) -> None:
    with _lock:
        _set_meta(key, value)


def transaction() -> Iterator[sqlite3.Connection]:
    conn = get_conn()
    with _lock:
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise


def now_ts() -> int:
    return int(time.time())
