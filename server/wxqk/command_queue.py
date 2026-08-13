# -*- coding: utf-8 -*-
"""Persistent device command queue with REVOKE priority and ACK."""
from __future__ import annotations

import json
import secrets
from typing import Any

import security_db as sdb

ALLOWED_COMMANDS = frozenset({
    "REVOKE_RUNTIME",
    "SUSPEND_RUNTIME",
    "REFRESH_POLICY",
    "SHOW_ANNOUNCEMENT",
    "START_DESKTOP",
    "STOP_DESKTOP",
    "FRIEND_CREDENTIAL_DIAGNOSTIC",
    "CHECK_CLIENT_UPDATE",
    # Legacy aliases mapped on enqueue
    "deny_run",
    "allow_run",
    "announce",
    "screenshot",
    "start_desktop",
    "stop_desktop",
    "friend_credential_diagnostic",
    "check_client_update",
})

_PRIORITY = {
    "REVOKE_RUNTIME": 100,
    "SUSPEND_RUNTIME": 90,
    "REFRESH_POLICY": 50,
    "CHECK_CLIENT_UPDATE": 45,
    "FRIEND_CREDENTIAL_DIAGNOSTIC": 42,
    "STOP_DESKTOP": 40,
    "START_DESKTOP": 30,
    "SHOW_ANNOUNCEMENT": 10,
}

_lock = sdb.db_lock
COMMAND_DELIVERY_LEASE_SEC = 30
DEFAULT_TTL_SEC = 24 * 3600


def _normalize_type(raw: str) -> str:
    t = str(raw or "").strip()
    alias = {
        "deny_run": "REVOKE_RUNTIME",
        "allow_run": "REFRESH_POLICY",
        "announce": "SHOW_ANNOUNCEMENT",
        "screenshot": "START_DESKTOP",
        "start_desktop": "START_DESKTOP",
        "stop_desktop": "STOP_DESKTOP",
        "friend_credential_diagnostic": "FRIEND_CREDENTIAL_DIAGNOSTIC",
        "check_client_update": "CHECK_CLIENT_UPDATE",
    }
    return alias.get(t, t)


def enqueue(
    device_id: str,
    command_type: str,
    payload: dict[str, Any] | None = None,
    *,
    policy_epoch: int = 0,
    ttl_sec: float = DEFAULT_TTL_SEC,
) -> dict[str, Any]:
    cid = str(device_id or "").strip()
    if not cid or cid == "unknown":
        return {"ok": False, "message": "missing_device_id"}
    ctype = _normalize_type(command_type)
    if ctype not in {
        "REVOKE_RUNTIME", "SUSPEND_RUNTIME", "REFRESH_POLICY",
        "SHOW_ANNOUNCEMENT", "START_DESKTOP", "STOP_DESKTOP",
        "FRIEND_CREDENTIAL_DIAGNOSTIC", "CHECK_CLIENT_UPDATE",
    }:
        return {"ok": False, "message": "command_not_allowed"}
    now = sdb.now_ts()
    cmd_id = secrets.token_hex(12)
    body = dict(payload or {})
    # Map legacy fields into payload for clients
    if ctype == "REVOKE_RUNTIME" and "message" not in body:
        body["message"] = body.get("userMessage") or "服务暂不可用"
    if ctype == "SHOW_ANNOUNCEMENT":
        body.setdefault("title", "公告")
    # Diagnostic / targeted update: short TTL by default (10 minutes)
    if ctype in ("FRIEND_CREDENTIAL_DIAGNOSTIC", "CHECK_CLIENT_UPDATE") and ttl_sec == DEFAULT_TTL_SEC:
        ttl_sec = 600.0
    row = {
        "command_id": cmd_id,
        "device_id": cid,
        "policy_epoch": int(policy_epoch or 0),
        "command_type": ctype,
        "payload_json": json.dumps(body, ensure_ascii=False, separators=(",", ":")),
        "issued_at": now,
        "expires_at": now + max(60.0, float(ttl_sec or DEFAULT_TTL_SEC)),
        "status": "PENDING",
        "delivery_count": 0,
        "server_signature": "",
    }
    with sdb.transaction():
        conn = sdb.get_conn()
        if ctype == "REVOKE_RUNTIME":
            conn.execute(
                """
                UPDATE device_commands
                SET status='EXPIRED', failed_at=?, failure_reason='superseded_by_revoke'
                WHERE device_id=? AND status IN ('PENDING','DELIVERED','RECEIVED')
                  AND command_type != 'REVOKE_RUNTIME'
                """,
                (now, cid),
            )
        elif ctype == "REFRESH_POLICY":
            conn.execute(
                """
                UPDATE device_commands
                SET status='EXPIRED', failed_at=?, failure_reason='superseded_by_refresh'
                WHERE device_id=? AND status IN ('PENDING','DELIVERED','RECEIVED')
                  AND command_type IN ('REVOKE_RUNTIME','SUSPEND_RUNTIME')
                  AND policy_epoch <= ?
                """,
                (now, cid, int(policy_epoch or 0)),
            )
        elif ctype == "START_DESKTOP":
            conn.execute(
                """
                UPDATE device_commands
                SET status='EXPIRED', failed_at=?, failure_reason='superseded_by_start_desktop'
                WHERE device_id=? AND status IN ('PENDING','DELIVERED','RECEIVED')
                  AND command_type IN ('STOP_DESKTOP', 'START_DESKTOP')
                """,
                (now, cid),
            )
        elif ctype == "STOP_DESKTOP":
            conn.execute(
                """
                UPDATE device_commands
                SET status='EXPIRED', failed_at=?, failure_reason='superseded_by_stop_desktop'
                WHERE device_id=? AND status IN ('PENDING','DELIVERED','RECEIVED')
                  AND command_type = 'START_DESKTOP'
                  AND issued_at <= ?
                """,
                (now, cid, now),
            )
        conn.execute(
            """
            INSERT INTO device_commands(
              command_id, device_id, policy_epoch, command_type, payload_json,
              issued_at, expires_at, status, delivery_count, server_signature
            ) VALUES (?,?,?,?,?,?,?,?,?,?)
            """,
            (
                row["command_id"], row["device_id"], row["policy_epoch"], row["command_type"],
                row["payload_json"], row["issued_at"], row["expires_at"], row["status"],
                0, "",
            ),
        )
    return {"ok": True, "commandId": cmd_id, "commandType": ctype, "policyEpoch": int(policy_epoch or 0)}


def _row_to_wire(r: Any) -> dict[str, Any]:
    payload = {}
    try:
        payload = json.loads(r["payload_json"] or "{}")
    except Exception:
        payload = {}
    ctype = r["command_type"]
    legacy_type = {
        "REVOKE_RUNTIME": "deny_run",
        "SUSPEND_RUNTIME": "deny_run",
        "REFRESH_POLICY": "allow_run",
        "SHOW_ANNOUNCEMENT": "announce",
        "START_DESKTOP": "start_desktop",
        "STOP_DESKTOP": "stop_desktop",
        "FRIEND_CREDENTIAL_DIAGNOSTIC": "friend_credential_diagnostic",
        "CHECK_CLIENT_UPDATE": "check_client_update",
    }.get(ctype, ctype)
    out = {
        "type": legacy_type,
        "commandType": ctype,
        "id": r["command_id"],
        "commandId": r["command_id"],
        "policyEpoch": int(r["policy_epoch"] or 0),
        "issuedAt": r["issued_at"],
        "expiresAt": r["expires_at"],
        **payload,
    }
    if ctype in ("REVOKE_RUNTIME", "SUSPEND_RUNTIME"):
        out["message"] = payload.get("message") or "服务暂不可用"
        out["action"] = ctype
    if ctype == "SHOW_ANNOUNCEMENT":
        out["title"] = payload.get("title") or "公告"
        out["text"] = payload.get("text") or ""
    if ctype == "START_DESKTOP":
        out["continuous"] = True
        out["type"] = "screenshot" if payload.get("legacyScreenshot") else "start_desktop"
    return out


def pop_next(device_id: str) -> dict[str, Any] | None:
    """Deliver highest-priority command; redeliver after lease if un-acked."""
    cid = str(device_id or "").strip()
    if not cid or cid == "unknown":
        return None
    now = sdb.now_ts()
    lease_cutoff = now - COMMAND_DELIVERY_LEASE_SEC
    with sdb.transaction():
        conn = sdb.get_conn()
        conn.execute(
            """
            UPDATE device_commands SET status='EXPIRED', failed_at=?, failure_reason='expired'
            WHERE device_id=? AND status IN ('PENDING','DELIVERED','RECEIVED') AND expires_at < ?
            """,
            (now, cid, now),
        )
        rows = conn.execute(
            """
            SELECT * FROM device_commands
            WHERE device_id=? AND expires_at >= ?
              AND (
                status='PENDING'
                OR (
                  status IN ('DELIVERED','RECEIVED')
                  AND (last_delivery_at IS NULL OR last_delivery_at <= ?)
                )
              )
            ORDER BY
              CASE command_type
                WHEN 'REVOKE_RUNTIME' THEN 0
                WHEN 'SUSPEND_RUNTIME' THEN 1
                WHEN 'REFRESH_POLICY' THEN 2
                WHEN 'CHECK_CLIENT_UPDATE' THEN 3
                WHEN 'FRIEND_CREDENTIAL_DIAGNOSTIC' THEN 4
                WHEN 'STOP_DESKTOP' THEN 5
                WHEN 'START_DESKTOP' THEN 6
                ELSE 7
              END,
              issued_at ASC
            LIMIT 1
            """,
            (cid, now, lease_cutoff),
        ).fetchall()
        if not rows:
            return None
        r = rows[0]
        conn.execute(
            """
            UPDATE device_commands
            SET status='DELIVERED', delivery_count=delivery_count+1, last_delivery_at=?
            WHERE command_id=?
            """,
            (now, r["command_id"]),
        )
        return _row_to_wire(r)


def mark_delivery_send_failed(device_id: str, command_id: str) -> None:
    """Backdate last_delivery_at so pop_next can retry after a send failure."""
    cid = str(device_id or "").strip()
    cmd_id = str(command_id or "").strip()
    if not cid or not cmd_id:
        return
    now = sdb.now_ts()
    with sdb.transaction():
        conn = sdb.get_conn()
        conn.execute(
            """
            UPDATE device_commands
            SET last_delivery_at=?
            WHERE command_id=? AND device_id=?
              AND status IN ('PENDING','DELIVERED','RECEIVED')
            """,
            (now - COMMAND_DELIVERY_LEASE_SEC, cmd_id, cid),
        )


def peek_pending(device_id: str, limit: int = 20) -> list[dict[str, Any]]:
    cid = str(device_id or "").strip()
    if not cid:
        return []
    now = sdb.now_ts()
    with sdb.db_lock:
        conn = sdb.get_conn()
        rows = conn.execute(
            """
            SELECT * FROM device_commands
            WHERE device_id=? AND status IN ('PENDING','DELIVERED','RECEIVED') AND expires_at >= ?
            ORDER BY issued_at DESC LIMIT ?
            """,
            (cid, now, max(1, min(int(limit or 20), 100))),
        ).fetchall()
    return [_row_to_wire(r) for r in rows]


def get_command(device_id: str, command_id: str) -> dict[str, Any] | None:
    cid = str(device_id or "").strip()
    cmd_id = str(command_id or "").strip()
    if not cid or not cmd_id:
        return None
    with sdb.db_lock:
        conn = sdb.get_conn()
        row = conn.execute(
            "SELECT * FROM device_commands WHERE command_id=? AND device_id=?",
            (cmd_id, cid),
        ).fetchone()
    return _row_to_wire(row) if row else None


def recent_commands(device_id: str, *, limit: int = 20, command_type: str = "") -> list[dict[str, Any]]:
    """Recent commands for diagnostics (any status)."""
    cid = str(device_id or "").strip()
    if not cid:
        return []
    ctype = _normalize_type(command_type) if command_type else ""
    lim = max(1, min(int(limit or 20), 100))
    with sdb.db_lock:
        conn = sdb.get_conn()
        if ctype:
            rows = conn.execute(
                """
                SELECT * FROM device_commands
                WHERE device_id=? AND command_type=?
                ORDER BY issued_at DESC LIMIT ?
                """,
                (cid, ctype, lim),
            ).fetchall()
        else:
            rows = conn.execute(
                """
                SELECT * FROM device_commands
                WHERE device_id=?
                ORDER BY issued_at DESC LIMIT ?
                """,
                (cid, lim),
            ).fetchall()
    return [_row_to_wire(r) for r in rows]


def ack(
    device_id: str,
    command_id: str,
    *,
    status: str = "APPLIED",
    failure_reason: str = "",
    client_ack_signature: str = "",
) -> dict[str, Any]:
    cid = str(device_id or "").strip()
    cmd_id = str(command_id or "").strip()
    if not cid or not cmd_id:
        return {"ok": False, "message": "missing_ids"}
    st = str(status or "APPLIED").upper()
    if st not in ("RECEIVED", "APPLIED", "FAILED"):
        st = "APPLIED"
    now = sdb.now_ts()
    with sdb.transaction():
        conn = sdb.get_conn()
        row = conn.execute(
            "SELECT * FROM device_commands WHERE command_id=? AND device_id=?",
            (cmd_id, cid),
        ).fetchone()
        if not row:
            return {"ok": False, "message": "command_not_found"}
        if row["status"] in ("APPLIED", "FAILED", "EXPIRED"):
            return {"ok": True, "duplicate": True, "status": row["status"]}
        if st == "RECEIVED":
            conn.execute(
                "UPDATE device_commands SET status=?, received_at=?, client_ack_signature=? WHERE command_id=?",
                (st, now, str(client_ack_signature or "")[:200], cmd_id),
            )
        elif st == "APPLIED":
            conn.execute(
                """
                UPDATE device_commands
                SET status=?, received_at=COALESCE(received_at,?), applied_at=?, client_ack_signature=?
                WHERE command_id=?
                """,
                (st, now, now, str(client_ack_signature or "")[:200], cmd_id),
            )
        else:
            conn.execute(
                """
                UPDATE device_commands
                SET status=?, failed_at=?, failure_reason=?, client_ack_signature=?
                WHERE command_id=?
                """,
                (st, now, str(failure_reason or "")[:200], str(client_ack_signature or "")[:200], cmd_id),
            )
    return {"ok": True, "status": st, "commandId": cmd_id}


def prune_terminal_commands(*, retention_days: float = 30, max_rows: int = 100_000) -> dict[str, int]:
    """Drop old APPLIED/FAILED/EXPIRED rows; cap total terminal rows.

    Excess rows are deleted via subquery LIMIT (single bind) — never expand
    tens of thousands of placeholders.
    """
    cutoff = sdb.now_ts() - float(retention_days) * 86400.0
    deleted = 0
    with sdb.transaction():
        conn = sdb.get_conn()
        cur = conn.execute(
            """
            DELETE FROM device_commands
            WHERE status IN ('APPLIED','FAILED','EXPIRED')
              AND COALESCE(applied_at, failed_at, expires_at, issued_at) < ?
            """,
            (cutoff,),
        )
        deleted += int(cur.rowcount or 0)
        count = int(
            conn.execute(
                "SELECT COUNT(*) FROM device_commands WHERE status IN ('APPLIED','FAILED','EXPIRED')"
            ).fetchone()[0]
        )
        if count > int(max_rows):
            excess = count - int(max_rows)
            cur2 = conn.execute(
                """
                DELETE FROM device_commands
                WHERE command_id IN (
                    SELECT command_id FROM device_commands
                    WHERE status IN ('APPLIED','FAILED','EXPIRED')
                    ORDER BY COALESCE(applied_at, failed_at, expires_at, issued_at) ASC
                    LIMIT ?
                )
                """,
                (excess,),
            )
            deleted += int(cur2.rowcount or 0)
    return {"deleted": deleted}


def legacy_wire_to_enqueue(device_id: str, cmd: dict[str, Any], policy_epoch: int = 0) -> dict[str, Any]:
    """Bridge old set_command({type:...}) into the persistent queue."""
    if not isinstance(cmd, dict):
        return {"ok": False, "message": "bad_cmd"}
    typ = str(cmd.get("type") or "")
    payload = {k: v for k, v in cmd.items() if k not in ("type", "id", "createdAt")}
    if typ == "screenshot":
        payload["legacyScreenshot"] = True
    return enqueue(device_id, typ, payload, policy_epoch=policy_epoch)
