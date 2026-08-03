#!/usr/bin/env python3
"""Predictor WebSocket hub — push current-table updates to prediction systems.

Auth: Admin Token (query ?token= or X-Admin-Token), same as admin viewer.
Subscribe filters (optional):
  - clientInstanceId
  - userId (accountHash)
  - omit both → receive all clients' table events

Existing HTTP POST/GET for table-state remain; this is a push complement.
"""
from __future__ import annotations

import threading
from typing import Any, Callable

_lock = threading.RLock()
# Each entry: {sock, clientInstanceId, userId, all}
_subscribers: list[dict[str, Any]] = []


def _safe(s: Any, n: int = 80) -> str:
    raw = "".join(ch if str(ch).isalnum() or ch in ("_", "-", ".") else "_" for ch in str(s or "").strip())
    return raw[:n]


def matches_subscription(sub: dict[str, Any], *, client_instance_id: str = "", user_id: str = "") -> bool:
    """Pure filter used by push + unit tests."""
    if sub.get("all"):
        return True
    cid = _safe(client_instance_id)
    uid = _safe(user_id, 64)
    want_cid = _safe(sub.get("clientInstanceId") or "")
    want_uid = _safe(sub.get("userId") or "", 64)
    if want_cid and cid and want_cid == cid:
        return True
    if want_uid and uid and want_uid == uid:
        return True
    return False


def register_predictor(sock, *, client_instance_id: str = "", user_id: str = "") -> dict[str, Any]:
    cid = _safe(client_instance_id)
    uid = _safe(user_id, 64)
    entry = {
        "sock": sock,
        "clientInstanceId": cid,
        "userId": uid,
        "all": not cid and not uid,
    }
    with _lock:
        _subscribers.append(entry)
    return entry


def unregister_predictor(sock) -> None:
    with _lock:
        global _subscribers
        _subscribers = [s for s in _subscribers if s.get("sock") is not sock]


def update_subscription(sock, *, client_instance_id: str = "", user_id: str = "") -> dict[str, Any] | None:
    cid = _safe(client_instance_id)
    uid = _safe(user_id, 64)
    with _lock:
        for s in _subscribers:
            if s.get("sock") is sock:
                s["clientInstanceId"] = cid
                s["userId"] = uid
                s["all"] = not cid and not uid
                return dict(s)
    return None


def predictor_count() -> int:
    with _lock:
        return len(_subscribers)


def push_to_predictors(
    obj: dict[str, Any],
    *,
    send_json: Callable[[Any, dict], None],
) -> int:
    """Fan-out event. Returns number of successful sends."""
    if not isinstance(obj, dict):
        return 0
    cid = _safe(obj.get("clientInstanceId") or obj.get("clientId") or "")
    uid = _safe(obj.get("userId") or obj.get("accountHash") or "", 64)
    with _lock:
        subs = list(_subscribers)
    dead = []
    sent = 0
    for s in subs:
        if not matches_subscription(s, client_instance_id=cid, user_id=uid):
            continue
        try:
            send_json(s["sock"], obj)
            sent += 1
        except Exception:
            dead.append(s.get("sock"))
    for sock in dead:
        unregister_predictor(sock)
    return sent
