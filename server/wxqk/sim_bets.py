#!/usr/bin/env python3
"""Sim-bet session summary + paginated settlement events.

Storage (preferred):
  {root}/{clientId}/{accountHash}/summary.json
  {root}/{clientId}/{accountHash}/events/{sessionId}.jsonl

Legacy (soft-read, no hard delete):
  {root}/{clientId}/summary.json
  {root}/{clientId}/events/{sessionId}.jsonl

Process-local EventFileCache avoids re-scanning the same jsonl on every ingest/query.
"""
from __future__ import annotations

import json
import re
import threading
from dataclasses import dataclass, field
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Any

TZ = timezone(timedelta(hours=8))
_lock = threading.RLock()

MAX_PAGE_SIZE = 100
DEFAULT_PAGE_SIZE = 50


def now_ms() -> int:
    return int(datetime.now(TZ).timestamp() * 1000)


def safe_client_id(cid: Any) -> str:
    s = "".join(ch if ch.isalnum() or ch in ("_", "-", ".") else "_" for ch in str(cid or "").strip())
    return s[:80]


def safe_session_id(sid: Any) -> str:
    s = "".join(ch if ch.isalnum() or ch in ("_", "-", ".") else "_" for ch in str(sid or "").strip())
    return s[:80]


def safe_account_hash(h: Any) -> str:
    s = re.sub(r"[^0-9a-fA-F]", "", str(h or "").strip())
    return s[:64].lower()


@dataclass
class EventFileCache:
    known_ids: set[str] = field(default_factory=set)
    event_count: int = 0
    file_size: int = 0
    file_mtime: float = 0.0
    line_offsets: list[int] = field(default_factory=list)  # byte offset of each non-empty line


class SimBetsStore:
    def __init__(self, root: Path):
        self.root = Path(root)
        self._event_caches: dict[str, EventFileCache] = {}
        self.full_scan_count = 0
        self.query_lines_parsed = 0  # lines decoded during query (for tests)

    def client_dir(self, client_id: str, account_hash: str = "") -> Path:
        cid = safe_client_id(client_id) or "unknown"
        ah = safe_account_hash(account_hash)
        p = self.root / cid / ah if ah else self.root / cid
        p.mkdir(parents=True, exist_ok=True)
        return p

    def legacy_client_dir(self, client_id: str) -> Path:
        cid = safe_client_id(client_id) or "unknown"
        return self.root / cid

    def summary_path(self, client_id: str, account_hash: str = "") -> Path:
        return self.client_dir(client_id, account_hash) / "summary.json"

    def events_path(self, client_id: str, session_id: str, account_hash: str = "") -> Path:
        sid = safe_session_id(session_id) or "_default"
        d = self.client_dir(client_id, account_hash) / "events"
        d.mkdir(parents=True, exist_ok=True)
        return d / f"{sid}.jsonl"

    def _resolve_read_dir(self, client_id: str, account_hash: str = "") -> tuple[Path, str]:
        """Prefer hash-scoped dir; soft-fallback to legacy cid dir when hash path empty."""
        ah = safe_account_hash(account_hash)
        if ah:
            hashed = self.client_dir(client_id, ah)
            if (hashed / "summary.json").exists():
                return hashed, ah
            legacy = self.legacy_client_dir(client_id)
            legacy_sum = legacy / "summary.json"
            if legacy_sum.exists():
                doc = self._read_json(legacy_sum)
                stored_hash = safe_account_hash(doc.get("accountHash") or "")
                if stored_hash and stored_hash != ah:
                    return hashed, ah
                return legacy, ""
            return hashed, ah
        return self.client_dir(client_id, ""), ""

    def _read_json(self, path: Path) -> dict[str, Any]:
        if not path.exists():
            return {}
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            return data if isinstance(data, dict) else {}
        except Exception:
            return {}

    def _write_json(self, path: Path, doc: dict[str, Any]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        tmp.replace(path)

    def _cache_key(self, path: Path) -> str:
        return str(path.resolve()) if path else ""

    def _stat(self, path: Path) -> tuple[int, float] | None:
        try:
            if not path.exists():
                return None
            st = path.stat()
            return int(st.st_size), float(st.st_mtime)
        except OSError:
            return None

    def _load_event_cache(self, path: Path) -> EventFileCache:
        key = self._cache_key(path)
        st = self._stat(path)
        cached = self._event_caches.get(key)
        if cached is not None and st is not None:
            if cached.file_size == st[0] and abs(cached.file_mtime - st[1]) < 1e-6:
                return cached
        if cached is not None and st is None and cached.event_count == 0 and cached.file_size == 0:
            return cached

        self.full_scan_count += 1
        cache = EventFileCache()
        if st is None:
            self._event_caches[key] = cache
            return cache
        try:
            with path.open("rb") as f:
                offset = 0
                while True:
                    line_b = f.readline()
                    if not line_b:
                        break
                    next_off = offset + len(line_b)
                    text = line_b.decode("utf-8", errors="replace").strip()
                    if text:
                        cache.line_offsets.append(offset)
                        cache.event_count += 1
                        try:
                            row = json.loads(text)
                            eid = str((row or {}).get("id") or "").strip()
                            if eid:
                                cache.known_ids.add(eid)
                        except Exception:
                            pass
                    offset = next_off
            cache.file_size = st[0]
            cache.file_mtime = st[1]
        except Exception:
            cache = EventFileCache()
            if st:
                cache.file_size = st[0]
                cache.file_mtime = st[1]
        self._event_caches[key] = cache
        return cache

    def _invalidate_cache(self, path: Path) -> None:
        self._event_caches.pop(self._cache_key(path), None)

    def get_event_cache(self, path: Path) -> EventFileCache:
        with _lock:
            return self._load_event_cache(path)

    def ingest(
        self,
        *,
        client_id: str,
        account: str = "",
        account_hash: str = "",
        summary: dict[str, Any] | None = None,
        events: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        cid = safe_client_id(client_id)
        if not cid:
            return {"ok": False, "accepted": 0, "message": "missing_clientId"}
        ah = safe_account_hash(account_hash)
        if isinstance(summary, dict) and not ah:
            ah = safe_account_hash(summary.get("accountHash") or "")
        accepted = 0
        with _lock:
            sum_path = self.summary_path(cid, ah)
            cur = self._read_json(sum_path)
            if ah and not cur:
                legacy_doc = self._read_json(self.legacy_client_dir(cid) / "summary.json")
                legacy_hash = safe_account_hash(legacy_doc.get("accountHash") or "")
                if legacy_doc and (not legacy_hash or legacy_hash == ah):
                    cur = dict(legacy_doc)
            session_id = ""
            if isinstance(summary, dict) and summary.get("sessionId"):
                session_id = safe_session_id(summary.get("sessionId"))
            if not session_id:
                session_id = safe_session_id(cur.get("sessionId")) or ""

            if events:
                by_session: dict[str, list[dict[str, Any]]] = {}
                for raw in events:
                    if not isinstance(raw, dict):
                        continue
                    eid = str(raw.get("id") or raw.get("ledgerId") or raw.get("betTransactionId") or "").strip()
                    if not eid:
                        continue
                    sid = safe_session_id(raw.get("sessionId") or session_id) or "_default"
                    if not session_id:
                        session_id = sid
                    row = {
                        "id": eid[:120],
                        "sessionId": sid,
                        "gameResult": str(raw.get("gameResult") or "").upper()[:16],
                        "createdAt": str(raw.get("createdAt") or "")[:48],
                        "settledAt": str(raw.get("settledAt") or raw.get("settlementAt") or "")[:48],
                        "tableId": int(raw.get("tableId") or 0) or 0,
                        "tableTitle": str(raw.get("tableTitle") or raw.get("title") or "")[:80],
                        "betSide": str(raw.get("betSide") or "")[:16],
                        "betAmount": float(raw.get("betAmount") or 0) if raw.get("betAmount") is not None else 0,
                    }
                    by_session.setdefault(sid, []).append(row)

                for sid, rows in by_session.items():
                    path = self.events_path(cid, sid, ah)
                    cache = self._load_event_cache(path)
                    # Soft-merge legacy known ids once (no re-scan if already in cache).
                    if ah:
                        legacy_path = self.legacy_client_dir(cid) / "events" / f"{safe_session_id(sid) or '_default'}.jsonl"
                        if legacy_path.exists():
                            leg = self._load_event_cache(legacy_path)
                            cache.known_ids |= leg.known_ids

                    new_rows = [r for r in rows if r["id"] not in cache.known_ids]
                    if not new_rows:
                        continue
                    path.parent.mkdir(parents=True, exist_ok=True)
                    with path.open("ab") as f:
                        for r in new_rows:
                            offset = f.tell()
                            line = (json.dumps(r, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
                            f.write(line)
                            cache.known_ids.add(r["id"])
                            cache.line_offsets.append(offset)
                            cache.event_count += 1
                            accepted += 1
                    st = self._stat(path)
                    if st:
                        cache.file_size = st[0]
                        cache.file_mtime = st[1]
                    self._event_caches[self._cache_key(path)] = cache

            if isinstance(summary, dict) and summary:
                incoming_saved = int(summary.get("savedAt") or 0) or 0
                cur_saved = int(cur.get("savedAt") or 0) or 0
                if incoming_saved >= cur_saved or not cur:
                    sid = safe_session_id(summary.get("sessionId") or session_id) or session_id or "_default"
                    ev_path = self.events_path(cid, sid, ah) if sid else None
                    event_count = self._load_event_cache(ev_path).event_count if ev_path else int(cur.get("eventCount") or 0)
                    win = int(summary.get("win") or 0)
                    lose = int(summary.get("lose") or 0)
                    tie = int(summary.get("tie") or 0)
                    doc = {
                        "clientId": cid,
                        "account": str(summary.get("account") or account or "")[:40],
                        "accountHash": ah or safe_account_hash(summary.get("accountHash") or "") or str(cur.get("accountHash") or ""),
                        "sessionId": sid,
                        "startedAt": int(summary.get("startedAt") or 0) or 0,
                        "win": max(0, win),
                        "lose": max(0, lose),
                        "tie": max(0, tie),
                        "pending": max(0, int(summary.get("pending") or 0)),
                        "total": max(0, int(summary.get("total") or (win + lose + tie))),
                        "decided": max(0, int(summary.get("decided") or (win + lose))),
                        "currentLoseStreak": max(0, int(summary.get("currentLoseStreak") or 0)),
                        "maxLoseStreak": max(0, int(summary.get("maxLoseStreak") or 0)),
                        "eventCount": event_count,
                        "savedAt": incoming_saved or now_ms(),
                    }
                    self._write_json(sum_path, doc)
                elif accepted > 0 and session_id:
                    cur["eventCount"] = self._load_event_cache(self.events_path(cid, session_id, ah)).event_count
                    cur["clientId"] = cid
                    if account and not cur.get("account"):
                        cur["account"] = str(account)[:40]
                    if ah and not cur.get("accountHash"):
                        cur["accountHash"] = ah
                    self._write_json(sum_path, cur)
            elif accepted > 0 and session_id:
                if not cur:
                    cur = {
                        "clientId": cid,
                        "account": str(account or "")[:40],
                        "accountHash": ah,
                        "sessionId": session_id,
                        "startedAt": 0,
                        "win": 0,
                        "lose": 0,
                        "tie": 0,
                        "pending": 0,
                        "total": 0,
                        "decided": 0,
                        "currentLoseStreak": 0,
                        "maxLoseStreak": 0,
                        "savedAt": now_ms(),
                    }
                cur["eventCount"] = self._load_event_cache(self.events_path(cid, session_id, ah)).event_count
                if ah and not cur.get("accountHash"):
                    cur["accountHash"] = ah
                self._write_json(sum_path, cur)

        return {"ok": True, "accepted": accepted}

    def get_summary(self, client_id: str, account_hash: str = "") -> dict[str, Any]:
        cid = safe_client_id(client_id)
        if not cid:
            return {"ok": True, "empty": True}
        with _lock:
            _dir, _ah = self._resolve_read_dir(cid, account_hash)
            doc = self._read_json(_dir / "summary.json")
        if not doc or not doc.get("sessionId"):
            return {"ok": True, "empty": True, "clientId": cid}
        out = dict(doc)
        out["ok"] = True
        out["empty"] = False
        return out

    def _read_lines_by_offsets(
        self,
        path: Path,
        cache: EventFileCache,
        start: int,
        end: int,
    ) -> list[dict[str, Any]]:
        """Read rows [start, end) in file order using cached byte offsets."""
        rows: list[dict[str, Any]] = []
        if start >= end or start < 0:
            return rows
        try:
            with path.open("rb") as f:
                for i in range(start, end):
                    if i >= len(cache.line_offsets):
                        break
                    f.seek(cache.line_offsets[i])
                    line_b = f.readline()
                    text = line_b.decode("utf-8", errors="replace").strip()
                    if not text:
                        continue
                    self.query_lines_parsed += 1
                    try:
                        row = json.loads(text)
                    except Exception:
                        continue
                    if isinstance(row, dict):
                        rows.append(row)
        except Exception:
            return []
        return rows

    def _tail_page_rows(self, path: Path, page_size: int) -> list[dict[str, Any]]:
        """Page-1 fast path: read a trailing byte window and take last page_size lines."""
        try:
            size = path.stat().st_size
        except OSError:
            return []
        if size <= 0:
            return []
        # Heuristic ~400 bytes/line; over-read a bit.
        cap = min(size, max(64_000, page_size * 600))
        try:
            with path.open("rb") as f:
                f.seek(max(0, size - cap))
                raw = f.read()
            if size > cap and b"\n" in raw:
                raw = raw.split(b"\n", 1)[1]
            lines = [ln for ln in raw.decode("utf-8", errors="replace").splitlines() if ln.strip()]
            lines = lines[-page_size:]
            rows: list[dict[str, Any]] = []
            for text in lines:
                self.query_lines_parsed += 1
                try:
                    row = json.loads(text)
                except Exception:
                    continue
                if isinstance(row, dict):
                    rows.append(row)
            rows.reverse()  # newest first
            return rows
        except Exception:
            return []

    def query_events(
        self,
        *,
        client_id: str,
        account_hash: str = "",
        session_id: str = "",
        page: int = 1,
        page_size: int = DEFAULT_PAGE_SIZE,
    ) -> dict[str, Any]:
        cid = safe_client_id(client_id)
        if not cid:
            return {"ok": False, "message": "missing_clientId", "rows": [], "total": 0}
        page = max(1, int(page or 1))
        page_size = min(MAX_PAGE_SIZE, max(1, int(page_size or DEFAULT_PAGE_SIZE)))
        with _lock:
            read_dir, ah = self._resolve_read_dir(cid, account_hash)
            if not session_id:
                session_id = str(self._read_json(read_dir / "summary.json").get("sessionId") or "")
            sid = safe_session_id(session_id)
            path = (read_dir / "events" / f"{sid}.jsonl") if sid else None
            if not path or not path.exists():
                return {
                    "ok": True,
                    "sessionId": sid,
                    "rows": [],
                    "total": 0,
                    "page": page,
                    "pageSize": page_size,
                    "hasMore": False,
                }
            cache = self._load_event_cache(path)
            total = cache.event_count

            if page == 1 and total > 0:
                # Prefer tail read so page-1 never walks 100k offsets unless needed.
                rows = self._tail_page_rows(path, page_size)
                # If cache count disagrees badly, fall back to offset slice.
                if len(rows) < min(page_size, total) and cache.line_offsets:
                    start = max(0, total - page_size)
                    end = total
                    file_rows = self._read_lines_by_offsets(path, cache, start, end)
                    file_rows.reverse()
                    rows = file_rows
            else:
                start = max(0, total - page * page_size)
                end = max(0, total - (page - 1) * page_size)
                file_rows = self._read_lines_by_offsets(path, cache, start, end)
                file_rows.reverse()
                rows = file_rows

        return {
            "ok": True,
            "sessionId": sid,
            "rows": rows,
            "total": total,
            "page": page,
            "pageSize": page_size,
            "hasMore": (page * page_size) < total,
        }

    def aggregate_tables(
        self,
        *,
        client_id: str,
        account_hash: str = "",
        max_events: int = 20_000,
    ) -> dict[str, Any]:
        """Aggregate current-session sim events by tableId."""
        cid = safe_client_id(client_id)
        if not cid:
            return {"ok": True, "rows": [], "sessionId": "", "total": 0}
        with _lock:
            read_dir, _ah = self._resolve_read_dir(cid, account_hash)
            summary = self._read_json(read_dir / "summary.json")
            sid = safe_session_id(summary.get("sessionId") or "")
            path = (read_dir / "events" / f"{sid}.jsonl") if sid else None
            if not path or not path.exists():
                return {"ok": True, "rows": [], "sessionId": sid or "", "total": 0, "summary": summary or {}}
            cache = self._load_event_cache(path)
            total = cache.event_count
            start = max(0, total - max(1, min(int(max_events or 20_000), 50_000)))
            events = self._read_lines_by_offsets(path, cache, start, total)
        buckets: dict[str, dict[str, Any]] = {}
        for raw in events:
            if not isinstance(raw, dict):
                continue
            tid = int(raw.get("tableId") or 0) or 0
            title = str(raw.get("tableTitle") or "").strip()
            gr = str(raw.get("gameResult") or "").upper()
            key = str(tid)
            b = buckets.setdefault(key, {
                "tableId": tid,
                "tableTitle": title,
                "win": 0, "lose": 0, "tie": 0,
                "betAmountSum": 0.0,
            })
            if title and not b.get("tableTitle"):
                b["tableTitle"] = title
            if gr == "WIN":
                b["win"] += 1
            elif gr == "LOSE":
                b["lose"] += 1
            elif gr == "TIE":
                b["tie"] += 1
            else:
                continue
            try:
                b["betAmountSum"] += float(raw.get("betAmount") or 0)
            except Exception:
                pass
        out = []
        for b in buckets.values():
            decided = int(b["win"]) + int(b["lose"])
            b["decided"] = decided
            b["total"] = decided + int(b["tie"])
            b["winRatePct"] = round(100.0 * b["win"] / decided, 1) if decided else None
            out.append(b)
        out.sort(key=lambda x: (-(x["win"] + x["lose"] + x["tie"]), -(x.get("tableId") or 0)))
        return {
            "ok": True,
            "sessionId": sid or "",
            "rows": out,
            "total": total,
            "summary": summary or {},
        }

    # Test helpers
    def reset_perf_counters(self) -> None:
        self.full_scan_count = 0
        self.query_lines_parsed = 0
