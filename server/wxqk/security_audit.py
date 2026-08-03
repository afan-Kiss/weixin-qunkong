# -*- coding: utf-8 -*-
"""Append-only security audit events (P0)."""
from __future__ import annotations

import json
import secrets
import threading
from typing import Any

import security_db as sdb

_lock = threading.Lock()


def emit(
    event_type: str,
    *,
    device_id: str = "",
    account_hash: str = "",
    build_id: str = "",
    policy_epoch: int | None = None,
    decision_id: str = "",
    command_id: str = "",
    reason_code: str = "",
    detail: dict[str, Any] | None = None,
) -> str:
    eid = secrets.token_hex(10)
    now = sdb.now_ts()
    detail_json = ""
    if detail:
        # Never persist secrets
        safe = {
            k: v for k, v in detail.items()
            if str(k).lower() not in ("password", "token", "authorization", "cookie", "signature")
        }
        try:
            detail_json = json.dumps(safe, ensure_ascii=False, separators=(",", ":"))[:2000]
        except Exception:
            detail_json = ""
    with _lock:
        conn = sdb.get_conn()
        conn.execute(
            """
            INSERT INTO security_audit(
              event_id, timestamp, event_type, device_id, account_hash, build_id,
              policy_epoch, decision_id, command_id, reason_code, detail_json
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
            """,
            (
                eid, now, str(event_type or "")[:64],
                str(device_id or "")[:80], str(account_hash or "")[:64],
                str(build_id or "")[:80],
                int(policy_epoch) if policy_epoch is not None else None,
                str(decision_id or "")[:80], str(command_id or "")[:80],
                str(reason_code or "")[:80], detail_json,
            ),
        )
        conn.commit()
    return eid
