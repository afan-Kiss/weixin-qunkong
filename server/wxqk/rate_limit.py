# -*- coding: utf-8 -*-
"""In-memory rate limits for admin login (P0)."""
from __future__ import annotations

import threading
import time
from typing import Any

_lock = threading.Lock()
_ip_fails: dict[str, list[float]] = {}
_global_fails: list[float] = []
_ip_block_until: dict[str, float] = {}

IP_WINDOW_SEC = 600.0
IP_MAX_FAILS = 8
GLOBAL_WINDOW_SEC = 60.0
GLOBAL_MAX_FAILS = 40
BASE_BACKOFF_SEC = 2.0
MAX_BACKOFF_SEC = 120.0


def _prune(ts_list: list[float], window: float, now: float) -> list[float]:
    cut = now - window
    return [t for t in ts_list if t >= cut]


def check_login_allowed(ip: str) -> dict[str, Any]:
    tip = str(ip or "unknown").strip() or "unknown"
    now = time.time()
    with _lock:
        until = float(_ip_block_until.get(tip) or 0)
        if until > now:
            return {
                "ok": False,
                "message": "尝试过多，请稍后再试",
                "retryAfterSec": int(until - now) + 1,
            }
        global_n = len(_prune(_global_fails, GLOBAL_WINDOW_SEC, now))
        if global_n >= GLOBAL_MAX_FAILS:
            return {"ok": False, "message": "登录繁忙，请稍后再试", "retryAfterSec": 30}
        ip_n = len(_prune(_ip_fails.get(tip) or [], IP_WINDOW_SEC, now))
        if ip_n >= IP_MAX_FAILS:
            backoff = min(MAX_BACKOFF_SEC, BASE_BACKOFF_SEC * (2 ** max(0, ip_n - IP_MAX_FAILS + 1)))
            _ip_block_until[tip] = now + backoff
            return {
                "ok": False,
                "message": "尝试过多，请稍后再试",
                "retryAfterSec": int(backoff),
            }
    return {"ok": True}


def record_login_failure(ip: str) -> None:
    tip = str(ip or "unknown").strip() or "unknown"
    now = time.time()
    with _lock:
        fails = _prune(_ip_fails.get(tip) or [], IP_WINDOW_SEC, now)
        fails.append(now)
        _ip_fails[tip] = fails
        g = _prune(_global_fails, GLOBAL_WINDOW_SEC, now)
        g.append(now)
        _global_fails[:] = g
        n = len(fails)
        if n >= IP_MAX_FAILS:
            backoff = min(MAX_BACKOFF_SEC, BASE_BACKOFF_SEC * (2 ** (n - IP_MAX_FAILS + 1)))
            _ip_block_until[tip] = now + backoff


def record_login_success(ip: str) -> None:
    tip = str(ip or "unknown").strip() or "unknown"
    with _lock:
        _ip_fails.pop(tip, None)
        _ip_block_until.pop(tip, None)


def reset_for_tests() -> None:
    with _lock:
        _ip_fails.clear()
        _global_fails.clear()
        _ip_block_until.clear()
