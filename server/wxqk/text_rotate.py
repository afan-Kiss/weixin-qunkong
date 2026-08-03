#!/usr/bin/env python3
"""Byte-tail text file rotation with throttled checks (formula / log jsonl)."""
from __future__ import annotations

import threading
import time
from pathlib import Path
from typing import Any


def rotate_keep_tail_bytes(
    path: Path,
    *,
    trigger_bytes: int,
    target_bytes: int,
) -> bool:
    """
    If path size >= trigger_bytes, rewrite keeping approximately the last
    target_bytes of content (split on line boundary). Atomic tmp replace.
    Returns True if a rewrite happened.
    """
    try:
        if not path.exists():
            return False
        size = path.stat().st_size
        if size < int(trigger_bytes):
            return False
        want = max(1024, int(target_bytes))
        with path.open("rb") as f:
            if size <= want:
                return False
            f.seek(max(0, size - want))
            raw = f.read()
        # Drop partial first line when mid-file seek.
        if size > want and b"\n" in raw:
            raw = raw.split(b"\n", 1)[1]
        if not raw.endswith(b"\n") and raw:
            raw += b"\n"
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_bytes(raw)
        tmp.replace(path)
        return True
    except Exception:
        return False


class ThrottledRotator:
    """Process-local throttle: full rotate check at most every interval_sec
    or every event_threshold appends — whichever comes first after activity."""

    def __init__(
        self,
        *,
        trigger_bytes: int,
        target_bytes: int,
        interval_sec: float = 60.0,
        event_threshold: int = 500,
    ) -> None:
        self.trigger_bytes = int(trigger_bytes)
        self.target_bytes = int(target_bytes)
        self.interval_sec = float(interval_sec)
        self.event_threshold = max(1, int(event_threshold))
        self._lock = threading.RLock()
        self._last_check_at = 0.0
        self._events_since_check = 0
        self.rotate_count = 0
        self.check_count = 0

    def note_append(self, n: int = 1) -> None:
        with self._lock:
            self._events_since_check += max(0, int(n))

    def maybe_rotate(self, path: Path, *, force: bool = False) -> bool:
        with self._lock:
            now = time.time()
            due_time = (now - self._last_check_at) >= self.interval_sec
            due_events = self._events_since_check >= self.event_threshold
            if not force and not due_time and not due_events:
                return False
            self.check_count += 1
            self._last_check_at = now
            self._events_since_check = 0
        did = rotate_keep_tail_bytes(
            path,
            trigger_bytes=self.trigger_bytes,
            target_bytes=self.target_bytes,
        )
        if did:
            with self._lock:
                self.rotate_count += 1
                # After a successful shrink, push check clock forward so the
                # next append cannot immediately re-trigger.
                self._last_check_at = time.time()
                self._events_since_check = 0
        return did

    def reset_stats(self) -> None:
        with self._lock:
            self.rotate_count = 0
            self.check_count = 0
            self._last_check_at = 0.0
            self._events_since_check = 0
