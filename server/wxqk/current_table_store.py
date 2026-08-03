#!/usr/bin/env python3
"""Current-table sync bridge for prediction systems (read-only consumers).

Write path: desktop client via device-signed upload.
Read path: Admin Token (X-Admin-Token).

Storage under {root}/:
  states/{client_instance_id}.json
  events/{source_id}__{table_id}__{shoe_id}.jsonl
  conflicts/{source_id}__{table_id}__{shoe_id}.jsonl

Round unique key: sourceId + tableId + shoeId + roundId
Same key + same result → deduped (no double write).
Same key + different result → conflict record, do not silent overwrite.
"""
from __future__ import annotations

import json
import re
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

TZ = timezone(timedelta(hours=8))
_lock = threading.RLock()

SOURCE_DEFAULT = "facai888"
HEARTBEAT_STALE_SEC = 20
MAX_ROAD_CELLS = 400
MAX_TABLE_NAME = 80
MAX_ID = 80
MAX_RESULT = 16

_SAFE_RE = re.compile(r"[^A-Za-z0-9_.\-]+")


def now_iso() -> str:
    return datetime.now(TZ).isoformat(timespec="milliseconds")


def now_ts() -> float:
    return datetime.now(TZ).timestamp()


def safe_id(v: Any, *, n: int = MAX_ID) -> str:
    s = _SAFE_RE.sub("_", str(v or "").strip())
    return s[:n]


def normalize_result(raw: Any) -> str:
    s = str(raw or "").strip().upper()
    if not s:
        return "UNKNOWN"
    mapping = {
        "B": "BANKER",
        "BANKER": "BANKER",
        "ZHUANG": "BANKER",
        "庄": "BANKER",
        "P": "PLAYER",
        "PLAYER": "PLAYER",
        "XIAN": "PLAYER",
        "闲": "PLAYER",
        "T": "TIE",
        "TIE": "TIE",
        "PUSH": "TIE",
        "HE": "TIE",
        "和": "TIE",
    }
    # Chinese may not upper() usefully — try raw too
    if s in mapping:
        return mapping[s]
    raw_s = str(raw or "").strip()
    if raw_s in mapping:
        return mapping[raw_s]
    if s in ("UNKNOWN", "UNK", "?"):
        return "UNKNOWN"
    return "UNKNOWN"


def _event_file_key(source_id: str, table_id: str, shoe_id: str) -> str:
    return f"{safe_id(source_id)}__{safe_id(table_id)}__{safe_id(shoe_id) or '_'}"


class CurrentTableStore:
    def __init__(self, root: Path):
        self.root = Path(root)
        self.states_dir = self.root / "states"
        self.events_dir = self.root / "events"
        self.conflicts_dir = self.root / "conflicts"
        self.states_dir.mkdir(parents=True, exist_ok=True)
        self.events_dir.mkdir(parents=True, exist_ok=True)
        self.conflicts_dir.mkdir(parents=True, exist_ok=True)
        # In-memory index of roundId -> result for hot shoes (dedup without full scan).
        # Capped — cold shoes fall back to file scan on next touch.
        self._round_index: dict[str, dict[str, str]] = {}
        self._round_index_order: list[str] = []
        self._max_shoe_indexes = 96

    def _touch_round_index(self, key: str, idx: dict[str, str]) -> dict[str, str]:
        if key in self._round_index:
            # move to end (most recently used)
            try:
                self._round_index_order.remove(key)
            except ValueError:
                pass
            self._round_index_order.append(key)
            return self._round_index[key]
        self._round_index[key] = idx
        self._round_index_order.append(key)
        while len(self._round_index_order) > self._max_shoe_indexes:
            old = self._round_index_order.pop(0)
            self._round_index.pop(old, None)
        return idx

    def _state_path(self, client_instance_id: str) -> Path:
        return self.states_dir / f"{safe_id(client_instance_id)}.json"

    def _events_path(self, source_id: str, table_id: str, shoe_id: str) -> Path:
        return self.events_dir / f"{_event_file_key(source_id, table_id, shoe_id)}.jsonl"

    def _conflicts_path(self, source_id: str, table_id: str, shoe_id: str) -> Path:
        return self.conflicts_dir / f"{_event_file_key(source_id, table_id, shoe_id)}.jsonl"

    def _read_json(self, path: Path) -> dict[str, Any]:
        try:
            if not path.exists():
                return {}
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            return {}

    def _write_json(self, path: Path, doc: dict[str, Any]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        tmp.replace(path)

    def _append_jsonl(self, path: Path, row: dict[str, Any]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")

    def _ensure_round_index(self, source_id: str, table_id: str, shoe_id: str) -> dict[str, str]:
        key = _event_file_key(source_id, table_id, shoe_id)
        cached = self._round_index.get(key)
        if cached is not None:
            return self._touch_round_index(key, cached)
        idx: dict[str, str] = {}
        path = self._events_path(source_id, table_id, shoe_id)
        if path.exists():
            try:
                with path.open("r", encoding="utf-8", errors="replace") as f:
                    for line in f:
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            row = json.loads(line)
                        except Exception:
                            continue
                        rid = safe_id(row.get("roundId"))
                        if not rid:
                            continue
                        idx[rid] = normalize_result(row.get("result"))
            except Exception:
                pass
        return self._touch_round_index(key, idx)

    def upsert_table_state(self, body: dict[str, Any]) -> dict[str, Any]:
        """POST /api/table-state (full snapshot or heartbeat)."""
        with _lock:
            client_id = safe_id(body.get("clientInstanceId") or body.get("clientId"))
            user_id = safe_id(body.get("userId") or body.get("accountHash"), n=64)
            if not client_id:
                return {"ok": False, "message": "missing clientInstanceId"}
            if not user_id:
                return {"ok": False, "message": "missing userId"}

            kind = str(body.get("kind") or "state").strip().lower()
            source_id = safe_id(body.get("sourceId") or SOURCE_DEFAULT) or SOURCE_DEFAULT
            table_id = safe_id(body.get("tableId"))
            shoe_id = safe_id(body.get("shoeId") or body.get("bootNo"))
            table_name = str(body.get("tableName") or "")[:MAX_TABLE_NAME]
            table_status = str(body.get("tableStatus") or "").strip().upper() or "ENTERED"
            online = body.get("online")
            if online is None:
                online = table_status not in ("LEFT", "HALL", "EXITING")
            online = bool(online)
            is_current = body.get("isCurrentTable")
            if is_current is None:
                is_current = online and table_status in ("ENTERED",)
            is_current = bool(is_current)

            prev = self._read_json(self._state_path(client_id))
            now = now_ts()
            iso = str(body.get("eventTime") or body.get("timestamp") or now_iso())

            doc: dict[str, Any] = {
                "userId": user_id,
                "clientInstanceId": client_id,
                "sourceId": source_id,
                "maskedAccount": str(body.get("maskedAccount") or prev.get("maskedAccount") or "")[:40],
                "tableId": table_id or str(prev.get("tableId") or ""),
                "tableName": table_name or str(prev.get("tableName") or ""),
                "shoeId": shoe_id if shoe_id else str(prev.get("shoeId") or ""),
                "roundId": safe_id(body.get("roundId") or body.get("lastRoundId") or prev.get("roundId") or ""),
                "roundIndex": body.get("roundIndex"),
                "tableStatus": table_status,
                "latestResult": normalize_result(body.get("latestResult") or prev.get("latestResult") or ""),
                "lastSeenAt": iso,
                "lastSeenTs": now,
                "online": online,
                "isCurrentTable": bool(is_current) and online,
                "lastSourceSequence": body.get("sourceSequence")
                if body.get("sourceSequence") is not None
                else body.get("lastSourceSequence", prev.get("lastSourceSequence")),
                "kind": kind,
                "updatedAt": iso,
            }
            if doc["roundIndex"] is None and prev.get("roundIndex") is not None and kind == "heartbeat":
                doc["roundIndex"] = prev.get("roundIndex")

            # Heartbeat must not wipe currentRoad; full state may replace.
            if kind == "heartbeat":
                if prev.get("currentRoad") is not None:
                    doc["currentRoad"] = prev.get("currentRoad")
            else:
                road = body.get("currentRoad")
                if isinstance(road, list):
                    cleaned = []
                    for cell in road[:MAX_ROAD_CELLS]:
                        if not isinstance(cell, dict):
                            continue
                        cleaned.append({
                            "roundId": safe_id(cell.get("roundId")),
                            "roundIndex": cell.get("roundIndex"),
                            "result": normalize_result(cell.get("result")),
                            "eventTime": str(cell.get("eventTime") or "")[:64],
                        })
                    doc["currentRoad"] = cleaned
                    if cleaned:
                        last = cleaned[-1]
                        if not doc.get("latestResult") or doc["latestResult"] == "UNKNOWN":
                            doc["latestResult"] = last.get("result") or "UNKNOWN"
                        if not doc.get("roundId"):
                            doc["roundId"] = last.get("roundId") or ""
                elif prev.get("currentRoad") is not None:
                    doc["currentRoad"] = prev.get("currentRoad")

            if not online:
                doc["isCurrentTable"] = False

            self._write_json(self._state_path(client_id), doc)
            return {
                "ok": True,
                "accepted": 1,
                "kind": kind,
                "clientInstanceId": client_id,
                "userId": user_id,
                "online": doc["online"],
                "tableId": doc["tableId"],
                "shoeId": doc["shoeId"],
            }

    def ingest_round_event(self, body: dict[str, Any]) -> dict[str, Any]:
        """POST /api/round-event — idempotent by unique key."""
        with _lock:
            client_id = safe_id(body.get("clientInstanceId") or body.get("clientId"))
            user_id = safe_id(body.get("userId") or body.get("accountHash"), n=64)
            source_id = safe_id(body.get("sourceId") or SOURCE_DEFAULT) or SOURCE_DEFAULT
            table_id = safe_id(body.get("tableId"))
            shoe_id = safe_id(body.get("shoeId") or body.get("bootNo"))
            round_id = safe_id(body.get("roundId"))
            if not client_id:
                return {"ok": False, "message": "missing clientInstanceId"}
            if not user_id:
                return {"ok": False, "message": "missing userId"}
            if not table_id:
                return {"ok": False, "message": "missing tableId"}
            if not shoe_id:
                return {"ok": False, "message": "missing shoeId"}
            if not round_id:
                return {"ok": False, "message": "missing roundId"}

            result = normalize_result(body.get("result"))
            if result == "UNKNOWN":
                return {
                    "ok": True,
                    "accepted": 0,
                    "ignored": 1,
                    "reason": "UNKNOWN_RESULT",
                    "message": "未知结果未落库",
                }

            idx = self._ensure_round_index(source_id, table_id, shoe_id)
            prev = idx.get(round_id)
            if prev is not None:
                if prev == result:
                    return {
                        "ok": True,
                        "accepted": 0,
                        "deduped": True,
                        "reason": "DUPLICATE",
                        "roundId": round_id,
                    }
                conflict = {
                    "sourceId": source_id,
                    "tableId": table_id,
                    "shoeId": shoe_id,
                    "roundId": round_id,
                    "existingResult": prev,
                    "incomingResult": result,
                    "clientInstanceId": client_id,
                    "userId": user_id,
                    "eventTime": str(body.get("eventTime") or now_iso()),
                    "receivedAt": now_iso(),
                    "rawPayloadHash": str(body.get("rawPayloadHash") or "")[:128],
                }
                self._append_jsonl(self._conflicts_path(source_id, table_id, shoe_id), conflict)
                return {
                    "ok": True,
                    "accepted": 0,
                    "conflict": True,
                    "reason": "RESULT_CONFLICT",
                    "existingResult": prev,
                    "incomingResult": result,
                    "roundId": round_id,
                    "message": "同一局出现不同结果，已记冲突，未覆盖",
                }

            row = {
                "sourceId": source_id,
                "tableId": table_id,
                "tableName": str(body.get("tableName") or "")[:MAX_TABLE_NAME],
                "shoeId": shoe_id,
                "roundId": round_id,
                "roundIndex": body.get("roundIndex"),
                "result": result,
                "eventTime": str(body.get("eventTime") or now_iso()),
                "sourceSequence": body.get("sourceSequence"),
                "receivedAt": now_iso(),
                "rawPayloadHash": str(body.get("rawPayloadHash") or "")[:128],
                "clientInstanceId": client_id,
                "userId": user_id,
            }
            self._append_jsonl(self._events_path(source_id, table_id, shoe_id), row)
            idx[round_id] = result

            # Soft-touch current state latest fields when this client is still on that table.
            state_path = self._state_path(client_id)
            st = self._read_json(state_path)
            if st and safe_id(st.get("tableId")) == table_id and safe_id(st.get("shoeId")) == shoe_id:
                st["latestResult"] = result
                st["roundId"] = round_id
                if body.get("roundIndex") is not None:
                    st["roundIndex"] = body.get("roundIndex")
                if body.get("sourceSequence") is not None:
                    st["lastSourceSequence"] = body.get("sourceSequence")
                st["lastSeenAt"] = now_iso()
                st["lastSeenTs"] = now_ts()
                st["online"] = True
                st["isCurrentTable"] = True
                st["tableStatus"] = str(st.get("tableStatus") or "ENTERED")
                # Append to currentRoad if present and not already last
                road = st.get("currentRoad")
                if isinstance(road, list):
                    if not road or safe_id(road[-1].get("roundId")) != round_id:
                        road.append({
                            "roundId": round_id,
                            "roundIndex": body.get("roundIndex"),
                            "result": result,
                            "eventTime": row["eventTime"],
                        })
                        st["currentRoad"] = road[-MAX_ROAD_CELLS:]
                self._write_json(state_path, st)

            return {
                "ok": True,
                "accepted": 1,
                "deduped": False,
                "conflict": False,
                "roundId": round_id,
                "result": result,
            }

    def _decorate_online(self, doc: dict[str, Any]) -> dict[str, Any]:
        out = dict(doc or {})
        ts = float(out.get("lastSeenTs") or 0)
        age = now_ts() - ts if ts > 0 else 1e9
        stale = age > HEARTBEAT_STALE_SEC
        if stale or not out.get("online"):
            out["online"] = False
            out["isCurrentTable"] = False
            if stale and ts > 0:
                out["offlineReason"] = "heartbeat_stale"
                out["offlineMessage"] = f"超过 {HEARTBEAT_STALE_SEC} 秒未收到心跳，视为已离线"
            elif not doc.get("online"):
                out["offlineReason"] = "left_or_offline"
                out["offlineMessage"] = "客户端已离桌或上报 offline"
        else:
            out["offlineReason"] = ""
            out["offlineMessage"] = ""
        out["heartbeatAgeSec"] = round(age, 1) if ts > 0 else None
        return out

    def get_current_table(
        self,
        *,
        client_instance_id: str = "",
        user_id: str = "",
    ) -> dict[str, Any]:
        with _lock:
            cid = safe_id(client_instance_id)
            uid = safe_id(user_id, n=64)
            doc: dict[str, Any] = {}
            if cid:
                doc = self._read_json(self._state_path(cid))
            elif uid:
                # Scan states for newest matching userId (small N of online clients).
                best: dict[str, Any] = {}
                best_ts = -1.0
                for path in self.states_dir.glob("*.json"):
                    row = self._read_json(path)
                    if safe_id(row.get("userId"), n=64) != uid:
                        continue
                    ts = float(row.get("lastSeenTs") or 0)
                    if ts >= best_ts:
                        best_ts = ts
                        best = row
                doc = best
            else:
                # No filter → newest seat across clients (prediction cold-start / admin pull).
                best: dict[str, Any] = {}
                best_ts = -1.0
                for path in self.states_dir.glob("*.json"):
                    row = self._read_json(path)
                    if not row:
                        continue
                    ts = float(row.get("lastSeenTs") or 0)
                    if ts >= best_ts:
                        best_ts = ts
                        best = row
                doc = best
            if not doc:
                return {
                    "ok": True,
                    "found": False,
                    "online": False,
                    "message": "没有该客户端/账号的当前桌记录",
                }
            decorated = self._decorate_online(doc)
            return {"ok": True, "found": True, "current": decorated}

    def get_shoe_history(
        self,
        *,
        source_id: str = SOURCE_DEFAULT,
        table_id: str = "",
        shoe_id: str = "",
    ) -> dict[str, Any]:
        with _lock:
            sid = safe_id(source_id) or SOURCE_DEFAULT
            tid = safe_id(table_id)
            shoe = safe_id(shoe_id)
            if not tid or not shoe:
                return {"ok": False, "message": "需要 tableId 与 shoeId"}
            path = self._events_path(sid, tid, shoe)
            rows: list[dict[str, Any]] = []
            if path.exists():
                try:
                    with path.open("r", encoding="utf-8", errors="replace") as f:
                        for line in f:
                            line = line.strip()
                            if not line:
                                continue
                            try:
                                rows.append(json.loads(line))
                            except Exception:
                                continue
                except Exception as e:
                    return {"ok": False, "message": str(e)}
            # Stable order: sourceSequence then file order
            def sort_key(r: dict[str, Any]) -> tuple:
                seq = r.get("sourceSequence")
                try:
                    seq_n = int(seq) if seq is not None else 10**12
                except Exception:
                    seq_n = 10**12
                return (seq_n, str(r.get("receivedAt") or ""))

            rows.sort(key=sort_key)
            return {
                "ok": True,
                "sourceId": sid,
                "tableId": tid,
                "shoeId": shoe,
                "count": len(rows),
                "rounds": rows,
            }
