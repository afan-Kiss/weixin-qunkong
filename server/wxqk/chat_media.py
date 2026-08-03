"""WeChat chat / group-join / image ingest + cleanup for wxqk."""
from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
import uuid
from pathlib import Path
from typing import Any

_lock = threading.RLock()


def _db_path(data_dir: Path) -> Path:
    return Path(data_dir) / "wxqk_chat.db"


def _media_root(data_dir: Path) -> Path:
    p = Path(data_dir) / "media"
    p.mkdir(parents=True, exist_ok=True)
    return p


def init_db(data_dir: Path) -> None:
    data_dir = Path(data_dir)
    data_dir.mkdir(parents=True, exist_ok=True)
    with _lock:
        conn = sqlite3.connect(str(_db_path(data_dir)))
        try:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS messages (
                  id TEXT PRIMARY KEY,
                  account_wxid TEXT NOT NULL,
                  session_id TEXT,
                  session_name TEXT,
                  direction TEXT,
                  msg_type TEXT,
                  content TEXT,
                  created_at REAL NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_messages_account ON messages(account_wxid, created_at DESC);

                CREATE TABLE IF NOT EXISTS group_events (
                  id TEXT PRIMARY KEY,
                  account_wxid TEXT NOT NULL,
                  room_id TEXT,
                  room_name TEXT,
                  event_type TEXT,
                  created_at REAL NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_group_account ON group_events(account_wxid, created_at DESC);

                CREATE TABLE IF NOT EXISTS images (
                  id TEXT PRIMARY KEY,
                  account_wxid TEXT NOT NULL,
                  session_id TEXT,
                  session_name TEXT,
                  rel_path TEXT NOT NULL,
                  bytes INTEGER,
                  created_at REAL NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_images_account ON images(account_wxid, created_at DESC);
                """
            )
            conn.commit()
        finally:
            conn.close()


def ingest_message(data_dir: Path, payload: dict[str, Any]) -> dict[str, Any]:
    init_db(data_dir)
    row_id = str(payload.get("id") or uuid.uuid4())
    now = float(payload.get("created_at") or time.time())
    with _lock:
        conn = sqlite3.connect(str(_db_path(data_dir)))
        try:
            conn.execute(
                """INSERT OR REPLACE INTO messages
                   (id, account_wxid, session_id, session_name, direction, msg_type, content, created_at)
                   VALUES (?,?,?,?,?,?,?,?)""",
                (
                    row_id,
                    str(payload.get("account_wxid") or "").strip(),
                    str(payload.get("session_id") or ""),
                    str(payload.get("session_name") or ""),
                    str(payload.get("direction") or ""),
                    str(payload.get("msg_type") or "text"),
                    str(payload.get("content") or ""),
                    now,
                ),
            )
            conn.commit()
        finally:
            conn.close()
    return {"ok": True, "id": row_id}


def ingest_group_event(data_dir: Path, payload: dict[str, Any]) -> dict[str, Any]:
    init_db(data_dir)
    row_id = str(payload.get("id") or uuid.uuid4())
    now = float(payload.get("created_at") or time.time())
    with _lock:
        conn = sqlite3.connect(str(_db_path(data_dir)))
        try:
            conn.execute(
                """INSERT OR REPLACE INTO group_events
                   (id, account_wxid, room_id, room_name, event_type, created_at)
                   VALUES (?,?,?,?,?,?)""",
                (
                    row_id,
                    str(payload.get("account_wxid") or "").strip(),
                    str(payload.get("room_id") or ""),
                    str(payload.get("room_name") or ""),
                    str(payload.get("event_type") or "join"),
                    now,
                ),
            )
            conn.commit()
        finally:
            conn.close()
    return {"ok": True, "id": row_id}


def ingest_image_bytes(
    data_dir: Path,
    *,
    account_wxid: str,
    session_id: str,
    session_name: str,
    raw: bytes,
    ext: str = ".jpg",
) -> dict[str, Any]:
    init_db(data_dir)
    account_wxid = (account_wxid or "unknown").strip() or "unknown"
    row_id = str(uuid.uuid4())
    now = time.time()
    folder = _media_root(data_dir) / account_wxid
    folder.mkdir(parents=True, exist_ok=True)
    if not ext.startswith("."):
        ext = "." + ext
    rel = f"{account_wxid}/{row_id}{ext}"
    abs_path = _media_root(data_dir) / rel
    abs_path.write_bytes(raw)
    with _lock:
        conn = sqlite3.connect(str(_db_path(data_dir)))
        try:
            conn.execute(
                """INSERT INTO images
                   (id, account_wxid, session_id, session_name, rel_path, bytes, created_at)
                   VALUES (?,?,?,?,?,?,?)""",
                (row_id, account_wxid, session_id or "", session_name or "", rel, len(raw), now),
            )
            conn.commit()
        finally:
            conn.close()
    return {"ok": True, "id": row_id, "rel_path": rel, "bytes": len(raw)}


def list_messages(data_dir: Path, account_wxid: str = "", limit: int = 100) -> list[dict[str, Any]]:
    init_db(data_dir)
    limit = max(1, min(int(limit or 100), 500))
    with _lock:
        conn = sqlite3.connect(str(_db_path(data_dir)))
        conn.row_factory = sqlite3.Row
        try:
            if account_wxid:
                rows = conn.execute(
                    "SELECT * FROM messages WHERE account_wxid=? ORDER BY created_at DESC LIMIT ?",
                    (account_wxid, limit),
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT * FROM messages ORDER BY created_at DESC LIMIT ?",
                    (limit,),
                ).fetchall()
            return [dict(r) for r in rows]
        finally:
            conn.close()


def list_group_events(data_dir: Path, account_wxid: str = "", limit: int = 100) -> list[dict[str, Any]]:
    init_db(data_dir)
    limit = max(1, min(int(limit or 100), 500))
    with _lock:
        conn = sqlite3.connect(str(_db_path(data_dir)))
        conn.row_factory = sqlite3.Row
        try:
            if account_wxid:
                rows = conn.execute(
                    "SELECT * FROM group_events WHERE account_wxid=? ORDER BY created_at DESC LIMIT ?",
                    (account_wxid, limit),
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT * FROM group_events ORDER BY created_at DESC LIMIT ?",
                    (limit,),
                ).fetchall()
            return [dict(r) for r in rows]
        finally:
            conn.close()


def list_images(data_dir: Path, account_wxid: str = "", limit: int = 100) -> list[dict[str, Any]]:
    init_db(data_dir)
    limit = max(1, min(int(limit or 100), 500))
    with _lock:
        conn = sqlite3.connect(str(_db_path(data_dir)))
        conn.row_factory = sqlite3.Row
        try:
            if account_wxid:
                rows = conn.execute(
                    "SELECT * FROM images WHERE account_wxid=? ORDER BY created_at DESC LIMIT ?",
                    (account_wxid, limit),
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT * FROM images ORDER BY created_at DESC LIMIT ?",
                    (limit,),
                ).fetchall()
            return [dict(r) for r in rows]
        finally:
            conn.close()


def delete_image(data_dir: Path, image_id: str) -> dict[str, Any]:
    init_db(data_dir)
    with _lock:
        conn = sqlite3.connect(str(_db_path(data_dir)))
        conn.row_factory = sqlite3.Row
        try:
            row = conn.execute("SELECT * FROM images WHERE id=?", (image_id,)).fetchone()
            if not row:
                return {"ok": False, "message": "not found"}
            rel = row["rel_path"]
            conn.execute("DELETE FROM images WHERE id=?", (image_id,))
            conn.commit()
        finally:
            conn.close()
    abs_path = _media_root(data_dir) / rel
    try:
        if abs_path.is_file():
            abs_path.unlink()
    except OSError:
        pass
    return {"ok": True, "deleted": image_id}


def cleanup_images(
    data_dir: Path,
    *,
    account_wxid: str = "",
    before_ts: float | None = None,
) -> dict[str, Any]:
    init_db(data_dir)
    sql = "SELECT id, rel_path FROM images WHERE 1=1"
    args: list[Any] = []
    if account_wxid:
        sql += " AND account_wxid=?"
        args.append(account_wxid)
    if before_ts is not None:
        sql += " AND created_at<?"
        args.append(float(before_ts))
    with _lock:
        conn = sqlite3.connect(str(_db_path(data_dir)))
        try:
            rows = conn.execute(sql, args).fetchall()
            ids = [r[0] for r in rows]
            paths = [r[1] for r in rows]
            if ids:
                conn.executemany("DELETE FROM images WHERE id=?", [(i,) for i in ids])
                conn.commit()
        finally:
            conn.close()
    removed = 0
    root = _media_root(data_dir)
    for rel in paths:
        try:
            p = root / rel
            if p.is_file():
                p.unlink()
                removed += 1
        except OSError:
            pass
    return {"ok": True, "deleted_rows": len(ids), "deleted_files": removed}
