#!/usr/bin/env python3
"""Compact hall road archive + formula win-rate replay.

Storage layout (permanent):
  {SIREN_DATA}/roads/{yyyy-mm-dd}/{tableId}.json

Compact bead alphabet:
  B=庄  P=闲  T=和
Optional parallel pair string (same length): 0=none 1=庄对 2=闲对 3=both

Legacy formula_stats still uses logical columns; strict replay uses big_road_engine.
Durable fingerprint is SHA256 via road_quality.compute_seq_hash (not Python hash()).
"""
from __future__ import annotations

import hashlib
import json
import re
import threading
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Any

from analytics_versions import ANALYTICS_ALGORITHM_VERSION, DATA_SCHEMA_VERSION
from road_quality import (
    boot_meta_from_body,
    compute_seq_hash,
    grade_quality,
    is_unknown_boot,
    soft_fingerprint,
    validate_beads,
)

try:
    import analytics_db as adb
except Exception:  # pragma: no cover
    adb = None  # type: ignore

TZ = timezone(timedelta(hours=8))
_lock = threading.RLock()  # legacy; prefer per-table locks below
_table_locks: dict[str, threading.RLock] = {}
_table_locks_guard = threading.RLock()
_fp_cache: dict[str, str] = {}  # day|tid|boot -> soft fingerprint (process-local only)
_client_hash: dict[str, dict[str, str]] = {}  # day|tid|boot|len -> {clientId: seqHash}
_overview_cache: dict[str, Any] | None = None
_overview_cache_at = 0.0
_overview_cache_ttl = 5.0
_overview_scan_count = 0


def _table_lock(day: str, tid: str) -> threading.RLock:
    key = f"{day}|{tid}"
    with _table_locks_guard:
        lk = _table_locks.get(key)
        if lk is None:
            lk = threading.RLock()
            _table_locks[key] = lk
        return lk


def _boot_fingerprint(seq: str, pairs: str, n: int) -> str:
    """Process-local soft fingerprint — NEVER use Python hash() for durable storage."""
    return soft_fingerprint(seq, pairs, n)


def invalidate_overview_cache() -> None:
    global _overview_cache, _overview_cache_at
    _overview_cache = None
    _overview_cache_at = 0.0

SIDE_MAP = {"B": "庄", "P": "闲", "T": "和"}
SIDE_INV = {"庄": "B", "闲": "P", "和": "T"}


def shanghai_day(ts: float | None = None) -> str:
    if ts is None:
        dt = datetime.now(TZ)
    else:
        dt = datetime.fromtimestamp(float(ts), TZ)
    return dt.strftime("%Y-%m-%d")


def safe_table_id(tid: Any) -> str:
    n = int(tid or 0)
    if n <= 0:
        return ""
    return str(n)


def parse_pattern(text: str) -> dict[str, Any]:
    """Parse 庄/闲 formula into columns (same rules as client bigRoadPatternParser)."""
    raw = str(text or "").strip()
    compact = re.sub(r"[\s,，、|/\n\r\t]+", "", raw)
    if not compact:
        return {"ok": False, "message": "公式不能为空"}
    tokens: list[str] = []
    for ch in compact:
        if ch not in ("庄", "闲"):
            if ch == "和":
                return {"ok": False, "message": "公式只能填写“庄”和“闲”"}
            return {"ok": False, "message": "公式只能填写“庄”和“闲”"}
        tokens.append(ch)
    if len(tokens) < 2:
        return {"ok": False, "message": "公式至少需要 2 个结果"}
    if len(tokens) > 24:
        return {"ok": False, "message": "公式最多 24 个结果"}
    columns: list[dict[str, Any]] = []
    for side in tokens:
        if columns and columns[-1]["side"] == side:
            columns[-1]["length"] += 1
        else:
            columns.append({"side": side, "length": 1})
    pattern_hash = "|".join(f"{c['side']}{c['length']}" for c in columns)
    return {
        "ok": True,
        "tokens": tokens,
        "columns": columns,
        "patternHash": pattern_hash,
        "normalized": "".join(tokens),
    }


def seq_to_columns(seq: str) -> list[dict[str, Any]]:
    """Build logical big-road columns from compact bead seq (skip ties)."""
    columns: list[dict[str, Any]] = []
    for ch in str(seq or ""):
        side = SIDE_MAP.get(ch)
        if side not in ("庄", "闲"):
            continue
        if columns and columns[-1]["side"] == side:
            columns[-1]["length"] += 1
        else:
            columns.append({"side": side, "length": 1})
    return columns


def columns_match_suffix(road_cols: list[dict[str, Any]], pattern_cols: list[dict[str, Any]]) -> bool:
    if not pattern_cols or len(road_cols) < len(pattern_cols):
        return False
    suffix = road_cols[-len(pattern_cols) :]
    for a, b in zip(suffix, pattern_cols):
        if a.get("side") != b.get("side") or int(a.get("length") or 0) != int(b.get("length") or 0):
            return False
    return True


def resolve_bet_side(mode: str, tip_side: str) -> str:
    m = str(mode or "follow").strip().lower()
    tip = tip_side if tip_side in ("庄", "闲") else ""
    if m in ("banker", "庄", "b"):
        return "庄"
    if m in ("player", "闲", "p"):
        return "闲"
    if m in ("against", "jump", "跳", "opposite"):
        if tip == "庄":
            return "闲"
        if tip == "闲":
            return "庄"
        return ""
    # follow / 追龙 default
    return tip


def settle_result(bet_side: str, road_side: str) -> str:
    """WIN/LOSE/TIE — ties excluded from win-rate denominator by caller."""
    buy = bet_side if bet_side in ("庄", "闲", "和") else ""
    side = road_side if road_side in ("庄", "闲", "和") else ""
    if not buy or not side:
        return ""
    if buy == "和":
        return "WIN" if side == "和" else "LOSE"
    if side == "和":
        return "TIE"
    return "WIN" if buy == side else "LOSE"


def replay_formula_on_seq(
    seq: str,
    pattern_cols: list[dict[str, Any]],
    bet_mode: str = "follow",
) -> dict[str, int]:
    """
    Walk prefix of seq; when pattern matches as latest suffix, settle vs next bead.
    Ties after a match are skipped (same as live auto: push bet, settle on next B/P).
    和局 → tie++ and not in win/lose; keep scanning until a non-tie or end.
    """
    win = lose = tie = matches = 0
    s = str(seq or "")
    if not s or not pattern_cols:
        return {"matches": 0, "win": 0, "lose": 0, "tie": 0}
    for i, ch in enumerate(s):
        if ch not in ("B", "P"):
            continue
        cols = seq_to_columns(s[: i + 1])
        if not columns_match_suffix(cols, pattern_cols):
            continue
        if i + 1 >= len(s):
            continue
        tip = cols[-1]["side"] if cols else ""
        bet = resolve_bet_side(bet_mode, tip)
        if not bet:
            continue
        matches += 1
        settled = False
        for j in range(i + 1, len(s)):
            nxt = SIDE_MAP.get(s[j], "")
            if not nxt:
                continue
            gr = settle_result(bet, nxt)
            if gr == "TIE":
                tie += 1
                continue
            if gr == "WIN":
                win += 1
            elif gr == "LOSE":
                lose += 1
            settled = True
            break
        if not settled:
            # Only trailing ties (or no usable bead) after match — already counted in tie.
            pass
    return {"matches": matches, "win": win, "lose": lose, "tie": tie}


class RoadArchive:
    def __init__(self, root: Path):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)

    def day_dir(self, day: str) -> Path:
        d = re.sub(r"[^0-9\-]", "", str(day or ""))[:10]
        if not re.match(r"^\d{4}-\d{2}-\d{2}$", d):
            d = shanghai_day()
        p = self.root / d
        p.mkdir(parents=True, exist_ok=True)
        return p

    def table_path(self, day: str, table_id: str) -> Path:
        return self.day_dir(day) / f"{table_id}.json"

    def _read_doc(self, path: Path) -> dict[str, Any]:
        if not path.exists():
            return {}
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            return {}

    def _write_doc(self, path: Path, doc: dict[str, Any]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        tmp.replace(path)

    def ingest(self, rows: list[dict[str, Any]], *, account: str = "", client_id: str = "") -> dict[str, Any]:
        accepted = 0
        errors: list[str] = []
        # Group by day + table so each table file is read/written at most once.
        groups: dict[tuple[str, str], list[dict[str, Any]]] = {}
        for row in rows or []:
            if not isinstance(row, dict):
                continue
            tid = safe_table_id(row.get("tid") or row.get("tableId"))
            if not tid:
                continue
            day = str(row.get("day") or shanghai_day()).strip()[:10]
            groups.setdefault((day, tid), []).append(row)

        wrote_any = False
        for (day, tid), batch in groups.items():
            lk = _table_lock(day, tid)
            with lk:
                try:
                    n, wrote = self._ingest_table_batch(day, tid, batch, account=account, client_id=client_id)
                    accepted += n
                    wrote_any = wrote_any or wrote
                except Exception as e:
                    errors.append(str(e)[:120])
        if wrote_any:
            invalidate_overview_cache()
        return {"ok": True, "accepted": accepted, "errors": errors[:10]}

    def _ingest_table_batch(
        self,
        day: str,
        tid: str,
        batch: list[dict[str, Any]],
        *,
        account: str,
        client_id: str,
    ) -> tuple[int, bool]:
        """Apply many rows for one table: one read, one write max. Returns (accepted, wrote)."""
        path = self.table_path(day, tid)
        doc = self._read_doc(path) or {
            "tid": int(tid) if str(tid).isdigit() else tid,
            "day": day,
            "title": "",
            "g": 0,
            "cat": "",
            "boots": {},
            "accounts": [],
            "clients": [],
        }
        try:
            doc["tid"] = int(tid)
        except Exception:
            doc["tid"] = tid

        accepted = 0
        dirty = False
        for row in batch:
            ok, changed = self._apply_row_to_doc(doc, row, account=account, client_id=client_id, day=day, tid=str(tid))
            if ok:
                accepted += 1
            if changed:
                dirty = True
        if dirty:
            self._write_doc(path, doc)
        return accepted, dirty

    def _apply_row_to_doc(
        self,
        doc: dict[str, Any],
        row: dict[str, Any],
        *,
        account: str,
        client_id: str,
        day: str,
        tid: str,
    ) -> tuple[bool, bool]:
        """Mutate doc in memory. Returns (accepted, changed)."""
        boot = str(row.get("boot") or row.get("bootNo") or "_").strip()[:40] or "_"
        mode = str(row.get("mode") or "full").strip().lower()
        fp_key = f"{day}|{tid}|{boot}"
        legacy_row = not (
            row.get("seqHash")
            or row.get("schemaVersion")
            or row.get("geometryVerified") is not None
        )

        if row.get("title"):
            doc["title"] = str(row.get("title"))[:80]
        if row.get("g") or row.get("gameTypeId"):
            try:
                doc["g"] = int(row.get("g") or row.get("gameTypeId") or 0)
            except Exception:
                pass
        if row.get("cat"):
            doc["cat"] = str(row.get("cat"))[:8]
        acc = str(row.get("account") or account or "").strip()[:40]
        cid = str(row.get("clientId") or client_id or "").strip()[:80]
        if acc and acc not in doc.setdefault("accounts", []):
            doc["accounts"] = (doc.get("accounts") or [])[-19:] + [acc]
        if cid and cid not in doc.setdefault("clients", []):
            doc["clients"] = (doc.get("clients") or [])[-19:] + [cid]

        boots: dict[str, Any] = doc.setdefault("boots", {})
        cur = boots.get(boot) or {"s": "", "p": "", "n": 0, "u": 0}
        seq = str(cur.get("s") or "")
        pairs = str(cur.get("p") or "")
        continuity_ok = bool(cur.get("co", True))
        soft_recovered = bool(cur.get("sr", False))
        shrink_unconfirmed = False
        reject_reason = ""

        # Fast skip identical full snapshots before merge work.
        if mode != "delta":
            full = str(row.get("seq") or row.get("s") or "")
            if full:
                preview_fp = _boot_fingerprint(full, str(row.get("pairs") or row.get("p") or ""), len(full))
                if _fp_cache.get(fp_key) == preview_fp and full == seq:
                    return True, False

        if mode == "delta":
            add = str(row.get("add") or "")
            add_p = str(row.get("addPairs") or row.get("add_p") or "")
            from_i = int(row.get("from") or 0)
            if from_i < 0:
                from_i = 0
            if not validate_beads(add):
                self._record_update(day, tid, boot, cid, row, accepted=False, reason="ILLEGAL_CHARS")
                return False, False
            prev_hash = str(row.get("previousSeqHash") or "")
            cur_hash = str(cur.get("h") or "")
            if from_i > len(seq):
                self._record_update(day, tid, boot, cid, row, accepted=False, reason="ROAD_DELTA_CONFLICT")
                return False, False
            if prev_hash and cur_hash and prev_hash != cur_hash:
                # Allow recovery via overlap check below; else conflict.
                soft_recovered = True
            if from_i < len(seq):
                overlap = len(seq) - from_i
                if len(add) < overlap:
                    new_u = int(row.get("u") or datetime.now(TZ).timestamp())
                    if new_u and int(cur.get("u") or 0) != new_u:
                        cur["u"] = new_u
                        boots[boot] = cur
                        doc["updatedAt"] = int(datetime.now(TZ).timestamp())
                        return True, True
                    return True, False
                if add[:overlap] != seq[from_i:]:
                    continuity_ok = False
                    self._record_update(day, tid, boot, cid, row, accepted=False, reason="ROAD_DELTA_CONFLICT")
                    return False, False
                add = add[overlap:]
                if add_p:
                    add_p = add_p[overlap:] if len(add_p) >= overlap else ""
                from_i = len(seq)
            seq = seq + add
            if add_p:
                pairs = (pairs + add_p)[: len(seq)]
            elif pairs:
                pairs = pairs[: len(seq)].ljust(len(seq), "0")
        else:
            full = str(row.get("seq") or row.get("s") or "")
            if not full:
                return False, False
            if not validate_beads(full):
                self._record_update(day, tid, boot, cid, row, accepted=False, reason="ILLEGAL_CHARS")
                return False, False
            if len(full) < len(seq) and seq.startswith(full):
                # Shrink: reject unless explicitly confirmed (legacy clients cannot confirm → keep longer).
                confirmed = bool(row.get("shrinkConfirmed") or row.get("forceReplace"))
                if not confirmed:
                    shrink_unconfirmed = True
                    self._record_update(day, tid, boot, cid, row, accepted=False, reason="ROAD_SHRINK_UNCONFIRMED")
                    # Mark quality down but do not overwrite longer seq.
                    q, reasons = grade_quality(
                        boot_no=boot,
                        continuity_ok=False,
                        geometry_verified=False,
                        classification_verified=False,
                        consensus_client_count=int(cur.get("cc") or 0),
                        source_client_count=int(cur.get("sc") or 0),
                        shrink_unconfirmed=True,
                        legacy=legacy_row,
                    )
                    cur["q"] = "D"
                    cur["qr"] = reasons
                    boots[boot] = cur
                    return False, True
                seq = full
                pairs = str(row.get("pairs") or row.get("p") or "")
            else:
                seq = full
                pairs = str(row.get("pairs") or row.get("p") or "")
                if pairs and len(pairs) < len(seq):
                    pairs = pairs.ljust(len(seq), "0")
                elif not pairs:
                    pairs = ""

        if len(seq) > 800:
            seq = seq[-800:]
            if pairs:
                pairs = pairs[-800:]
        if pairs and set(pairs) <= {"0"}:
            pairs = ""

        client_seq_hash = str(row.get("seqHash") or "")
        seq_hash = client_seq_hash or compute_seq_hash(day, tid, boot, seq, pairs or "")
        # Multi-client consensus / conflict at same length
        hk = f"{day}|{tid}|{boot}|{len(seq)}"
        bucket = _client_hash.setdefault(hk, {})
        conflict = False
        if cid:
            for other_cid, other_h in list(bucket.items()):
                if other_cid != cid and other_h and other_h != seq_hash:
                    conflict = True
                    break
            bucket[cid] = seq_hash
        consensus = len({h for h in bucket.values() if h})
        # Distinct clients agreeing on same hash
        agree = {}
        for oc, oh in bucket.items():
            agree.setdefault(oh, set()).add(oc)
        consensus_clients = max((len(v) for v in agree.values()), default=0)
        source_clients = len(bucket)

        geom_v = bool(row.get("geometryVerified")) if "geometryVerified" in row else bool(cur.get("gv", False))
        class_v = bool(row.get("classificationVerified")) if "classificationVerified" in row else bool(cur.get("cv", True))
        if legacy_row:
            # Old clients: never auto-promote to A
            geom_v = False
            class_v = bool(doc.get("cat"))

        q, reasons = grade_quality(
            boot_no=boot,
            continuity_ok=continuity_ok and not conflict,
            geometry_verified=geom_v,
            classification_verified=class_v,
            consensus_client_count=consensus_clients,
            source_client_count=source_clients,
            conflict=conflict,
            illegal_chars=False,
            legacy=legacy_row,
            soft_recovered=soft_recovered and legacy_row,
            missing_geometry=not geom_v,
            shrink_unconfirmed=shrink_unconfirmed,
        )

        new_u = int(row.get("u") or datetime.now(TZ).timestamp())
        if (
            seq == str(cur.get("s") or "")
            and (pairs or "") == str(cur.get("p") or "")
            and int(cur.get("n") or 0) == len(seq)
            and str(cur.get("h") or "") == seq_hash
            and str(cur.get("q") or "") == q
        ):
            _fp_cache[fp_key] = _boot_fingerprint(seq, pairs or "", len(seq))
            return True, False

        first_seen = int(cur.get("fs") or new_u)
        cur = {
            "s": seq,
            "n": len(seq),
            "u": new_u,
            "h": seq_hash,
            "q": q,
            "qr": reasons[:12],
            "co": 1 if continuity_ok and not conflict else 0,
            "gv": 1 if geom_v else 0,
            "cv": 1 if class_v else 0,
            "sc": source_clients,
            "cc": consensus_clients,
            "fs": first_seen,
            "sv": int(row.get("schemaVersion") or DATA_SCHEMA_VERSION),
            "av": str(row.get("algorithmVersion") or ANALYTICS_ALGORITHM_VERSION),
        }
        if soft_recovered:
            cur["sr"] = 1
        if pairs:
            cur["p"] = pairs[: len(seq)]
        boots[boot] = cur
        doc["boots"] = boots
        doc["updatedAt"] = datetime.now(TZ).strftime("%Y-%m-%d %H:%M:%S")
        _fp_cache[fp_key] = _boot_fingerprint(seq, pairs or "", len(seq))
        self._record_update(day, tid, boot, cid, row, accepted=True, reason="")
        self._sync_boot_sqlite(day, tid, boot, cur, doc)
        return True, True

    def _record_update(
        self,
        day: str,
        tid: str,
        boot: str,
        cid: str,
        row: dict[str, Any],
        *,
        accepted: bool,
        reason: str,
    ) -> None:
        if adb is None:
            return
        try:
            adb.get_conn()
        except Exception:
            return
        try:
            uid = hashlib.sha256(
                f"{day}|{tid}|{boot}|{cid}|{row.get('mode')}|{row.get('from')}|{row.get('seqHash')}|{row.get('u')}|{reason}".encode()
            ).hexdigest()
            now = int(time.time())
            conn = adb.get_conn()
            with adb._lock:
                conn.execute(
                    """
                    INSERT OR IGNORE INTO road_updates(
                      update_id, day, table_id, boot_no, client_id, account_hash, mode,
                      from_index, add_seq, full_seq_hash, previous_seq_hash, current_seq_hash,
                      current_seq_len, observed_at, received_at, accepted, reject_reason
                    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                    """,
                    (
                        uid,
                        day,
                        int(tid) if str(tid).isdigit() else 0,
                        boot,
                        cid[:80],
                        str(row.get("accountHash") or "")[:64],
                        str(row.get("mode") or "full")[:16],
                        int(row.get("from") or 0),
                        str(row.get("add") or "")[:200],
                        str(row.get("seqHash") or "")[:64],
                        str(row.get("previousSeqHash") or "")[:64],
                        str(row.get("seqHash") or "")[:64],
                        int(row.get("seqLen") or 0),
                        int(row.get("u") or now),
                        now,
                        1 if accepted else 0,
                        reason[:80],
                    ),
                )
                conn.commit()
        except Exception:
            pass

    def _sync_boot_sqlite(self, day: str, tid: str, boot: str, cur: dict[str, Any], doc: dict[str, Any]) -> None:
        if adb is None:
            return
        try:
            adb.get_conn()
        except Exception:
            return
        try:
            conn = adb.get_conn()
            reasons = cur.get("qr") or []
            with adb._lock:
                conn.execute(
                    """
                    INSERT INTO road_boots(
                      day, table_id, boot_no, title, game_type_id, category, seq, pairs, seq_len, seq_hash,
                      first_seen_at, updated_at, source_client_count, consensus_client_count,
                      continuity_ok, geometry_verified, classification_verified,
                      quality_level, quality_reasons, schema_version, algorithm_version
                    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                    ON CONFLICT(day, table_id, boot_no) DO UPDATE SET
                      title=excluded.title,
                      game_type_id=excluded.game_type_id,
                      category=excluded.category,
                      seq=excluded.seq,
                      pairs=excluded.pairs,
                      seq_len=excluded.seq_len,
                      seq_hash=excluded.seq_hash,
                      updated_at=excluded.updated_at,
                      source_client_count=excluded.source_client_count,
                      consensus_client_count=excluded.consensus_client_count,
                      continuity_ok=excluded.continuity_ok,
                      geometry_verified=excluded.geometry_verified,
                      classification_verified=excluded.classification_verified,
                      quality_level=excluded.quality_level,
                      quality_reasons=excluded.quality_reasons,
                      schema_version=excluded.schema_version,
                      algorithm_version=excluded.algorithm_version
                    """,
                    (
                        day,
                        int(tid) if str(tid).isdigit() else 0,
                        boot,
                        str(doc.get("title") or "")[:80],
                        int(doc.get("g") or 0),
                        str(doc.get("cat") or "")[:8],
                        str(cur.get("s") or ""),
                        str(cur.get("p") or ""),
                        int(cur.get("n") or 0),
                        str(cur.get("h") or ""),
                        int(cur.get("fs") or cur.get("u") or 0),
                        int(cur.get("u") or 0),
                        int(cur.get("sc") or 0),
                        int(cur.get("cc") or 0),
                        int(cur.get("co") or 0),
                        int(cur.get("gv") or 0),
                        int(cur.get("cv") or 0),
                        str(cur.get("q") or "C"),
                        json.dumps(reasons, ensure_ascii=False),
                        int(cur.get("sv") or DATA_SCHEMA_VERSION),
                        str(cur.get("av") or ANALYTICS_ALGORITHM_VERSION),
                    ),
                )
                conn.execute(
                    """
                    INSERT INTO road_client_hashes(day, table_id, boot_no, seq_len, client_id, seq_hash, updated_at)
                    VALUES(?,?,?,?,?,?,?)
                    ON CONFLICT(day, table_id, boot_no, seq_len, client_id) DO UPDATE SET
                      seq_hash=excluded.seq_hash, updated_at=excluded.updated_at
                    """,
                    (
                        day,
                        int(tid) if str(tid).isdigit() else 0,
                        boot,
                        int(cur.get("n") or 0),
                        (doc.get("clients") or ["_"])[-1] if doc.get("clients") else "_",
                        str(cur.get("h") or ""),
                        int(cur.get("u") or 0),
                    ),
                )
                conn.commit()
        except Exception:
            pass

    def collect_boots(
        self,
        *,
        day_from: str = "",
        day_to: str = "",
        table_id: int = 0,
        cat: str = "",
        quality_filter: str = "AB",
        limit_boots: int = 50_000,
        offset: int = 0,
    ) -> list[dict[str, Any]]:
        """Collect boot snapshots for strict replay (prefer SQLite when available)."""
        out: list[dict[str, Any]] = []
        skip = max(0, int(offset or 0))
        take = max(1, int(limit_boots or 1))
        if adb is not None:
            try:
                conn = adb.get_conn()
                where = ["1=1"]
                args: list[Any] = []
                if day_from:
                    where.append("day>=?")
                    args.append(day_from)
                if day_to:
                    where.append("day<=?")
                    args.append(day_to)
                if table_id > 0:
                    where.append("table_id=?")
                    args.append(int(table_id))
                if cat:
                    where.append("category=?")
                    args.append(cat)
                allowed = "AB" if str(quality_filter).upper() == "AB" else (
                    "ABC" if str(quality_filter).upper() == "ABC" else "ABCD"
                )
                if str(quality_filter).upper() not in ("ALL", "ABCD"):
                    where.append(f"quality_level IN ({','.join('?' * len(allowed))})")
                    args.extend(list(allowed))
                sql = (
                    f"SELECT * FROM road_boots WHERE {' AND '.join(where)} "
                    f"ORDER BY day, table_id, boot_no LIMIT ? OFFSET ?"
                )
                args.append(int(take))
                args.append(int(skip))
                for r in conn.execute(sql, args).fetchall():
                    out.append({
                        "day": r["day"],
                        "tableId": r["table_id"],
                        "bootNo": r["boot_no"],
                        "title": r["title"],
                        "cat": r["category"],
                        "seq": r["seq"],
                        "pairs": r["pairs"],
                        "seqHash": r["seq_hash"],
                        "qualityLevel": r["quality_level"],
                        "updatedAt": r["updated_at"],
                    })
                if out or skip == 0:
                    # Empty page with skip>0 still means SQLite path worked.
                    return out
            except Exception:
                out = []
        seen = 0
        for doc in self.iter_docs(day_from, day_to):
            if table_id > 0 and int(doc.get("tid") or 0) != int(table_id):
                continue
            if cat and str(doc.get("cat") or "") != str(cat):
                continue
            day = str(doc.get("day") or "")
            tid = doc.get("tid") or 0
            for boot, body in (doc.get("boots") or {}).items():
                meta = boot_meta_from_body(body or {}, day=day, table_id=tid, boot_no=str(boot))
                q = meta["qualityLevel"]
                # Legacy boots without quality → C
                if not (body or {}).get("q") and not (body or {}).get("qualityLevel"):
                    q = "C"
                    meta["qualityLevel"] = "C"
                allowed = set("AB") if str(quality_filter).upper() == "AB" else (
                    set("ABC") if str(quality_filter).upper() == "ABC" else set("ABCD")
                )
                if str(quality_filter).upper() not in ("ALL", "ABCD") and q not in allowed:
                    continue
                if seen < skip:
                    seen += 1
                    continue
                out.append(meta)
                if len(out) >= take:
                    return out
                seen += 1
        return out

    def migrate_roads_to_sqlite(self) -> dict[str, Any]:
        """Idempotent import of JSON road files into analytics.db road_boots."""
        if adb is None:
            return {"ok": False, "message": "analytics_db unavailable"}
        try:
            if adb.get_meta("roads_migrated") == "1":
                return {"ok": True, "skipped": True, "imported": 0}
        except Exception as e:
            return {"ok": False, "error": str(e)[:200]}
        imported = 0
        failed = 0
        try:
            for doc in self.iter_docs():
                day = str(doc.get("day") or "")
                tid = str(doc.get("tid") or "")
                for boot, body in (doc.get("boots") or {}).items():
                    try:
                        cur = dict(body or {})
                        if "q" not in cur:
                            cur["q"] = "C"
                            cur["qr"] = ["LEGACY_IMPORT"]
                            cur["co"] = 0
                            cur["gv"] = 0
                            cur["cv"] = 1 if doc.get("cat") else 0
                            cur["h"] = compute_seq_hash(
                                day, tid, str(boot), str(cur.get("s") or ""), str(cur.get("p") or "")
                            )
                        self._sync_boot_sqlite(day, tid, str(boot), cur, doc)
                        imported += 1
                    except Exception:
                        failed += 1
            adb.set_meta("roads_migrated", "1")
            adb.set_meta("roads_migrated_count", str(imported))
            return {"ok": True, "imported": imported, "failed": failed}
        except Exception as e:
            return {"ok": False, "imported": imported, "failed": failed, "error": str(e)[:200]}

    def _ingest_one(self, row: dict[str, Any], *, account: str, client_id: str) -> bool:
        """Compatibility wrapper — single-row ingest via batch path."""
        tid = safe_table_id(row.get("tid") or row.get("tableId"))
        if not tid:
            return False
        day = str(row.get("day") or shanghai_day()).strip()[:10]
        n, _ = self._ingest_table_batch(day, tid, [row], account=account, client_id=client_id)
        return n > 0

    def list_days(self) -> list[str]:
        if not self.root.exists():
            return []
        days = [p.name for p in self.root.iterdir() if p.is_dir() and re.match(r"^\d{4}-\d{2}-\d{2}$", p.name)]
        days.sort(reverse=True)
        return days

    def iter_docs(self, day_from: str = "", day_to: str = ""):
        days = self.list_days()
        for day in days:
            if day_from and day < day_from:
                continue
            if day_to and day > day_to:
                continue
            ddir = self.root / day
            for path in ddir.glob("*.json"):
                doc = self._read_doc(path)
                if doc:
                    yield doc

    def formula_stats(
        self,
        pattern_text: str,
        *,
        day_from: str = "",
        day_to: str = "",
        bet_mode: str = "follow",
        table_id: int = 0,
        cat: str = "",
        limit_boots: int = 50_000,
    ) -> dict[str, Any]:
        parsed = parse_pattern(pattern_text)
        if not parsed.get("ok"):
            return {"ok": False, "message": parsed.get("message") or "公式无效"}
        pattern_cols = parsed["columns"]
        win = lose = tie = matches = 0
        boots_scanned = 0
        tables = set()
        days = set()
        for doc in self.iter_docs(day_from, day_to):
            if table_id > 0 and int(doc.get("tid") or 0) != int(table_id):
                continue
            if cat and str(doc.get("cat") or "") != str(cat):
                continue
            day = str(doc.get("day") or "")
            tid = int(doc.get("tid") or 0)
            for boot, body in (doc.get("boots") or {}).items():
                if boots_scanned >= limit_boots:
                    break
                seq = str((body or {}).get("s") or "")
                if not seq:
                    continue
                boots_scanned += 1
                r = replay_formula_on_seq(seq, pattern_cols, bet_mode=bet_mode)
                matches += r["matches"]
                win += r["win"]
                lose += r["lose"]
                tie += r["tie"]
                if tid:
                    tables.add(tid)
                if day:
                    days.add(day)
            if boots_scanned >= limit_boots:
                break
        decided = win + lose
        win_rate = (win / decided) if decided > 0 else None
        return {
            "ok": True,
            "pattern": parsed.get("normalized"),
            "patternHash": parsed.get("patternHash"),
            "betMode": bet_mode,
            "dayFrom": day_from or "",
            "dayTo": day_to or "",
            "bootsScanned": boots_scanned,
            "tableCount": len(tables),
            "dayCount": len(days),
            "matches": matches,
            "win": win,
            "lose": lose,
            "tie": tie,
            "decided": decided,
            "winRate": win_rate,
            "winRatePct": None if win_rate is None else round(win_rate * 1000) / 10,
            "note": "胜率=赢/(赢+输)，和局不计；默认追龙(跟最后一列同向)",
        }

    def overview(self, *, limit_tables: int = 48) -> dict[str, Any]:
        global _overview_cache, _overview_cache_at, _overview_scan_count
        now = datetime.now(TZ).timestamp()
        if (
            _overview_cache is not None
            and (now - _overview_cache_at) < _overview_cache_ttl
        ):
            # Refresh serverTime only — rest is cached.
            out = dict(_overview_cache)
            out["serverTime"] = int(now)
            return out

        _overview_scan_count += 1
        days = self.list_days()
        table_files = 0
        recent_tables: list[dict[str, Any]] = []
        for d in days[:7]:
            day_path = self.root / d
            if not day_path.is_dir():
                continue
            # One glob + one stat per file (no double glob).
            with_mtime: list[tuple[float, Path]] = []
            for path in day_path.glob("*.json"):
                try:
                    mtime = path.stat().st_mtime
                except OSError:
                    continue
                with_mtime.append((mtime, path))
            table_files += len(with_mtime)
            with_mtime.sort(key=lambda x: x[0], reverse=True)
            for _mt, path in with_mtime:
                if len(recent_tables) >= max(1, int(limit_tables) or 48):
                    break
                doc = self._read_doc(path)
                if not doc:
                    continue
                boots = doc.get("boots") or {}
                best_boot = ""
                best_n = 0
                best_u = 0
                preview = ""
                best_q = "C"
                best_co = False
                best_gv = False
                best_sc = 0
                for bname, meta in boots.items():
                    if not isinstance(meta, dict):
                        continue
                    u = int(meta.get("u") or 0)
                    n = int(meta.get("n") or len(str(meta.get("s") or "")))
                    if u >= best_u:
                        best_u = u
                        best_boot = str(bname)
                        best_n = n
                        s = str(meta.get("s") or "")
                        preview = s[-32:] if s else ""
                        best_q = str(meta.get("q") or "C")
                        best_co = bool(meta.get("co"))
                        best_gv = bool(meta.get("gv"))
                        best_sc = int(meta.get("sc") or 0)
                recent_tables.append({
                    "day": d,
                    "tid": doc.get("tid") or 0,
                    "title": str(doc.get("title") or "")[:40],
                    "cat": str(doc.get("cat") or ""),
                    "boot": best_boot,
                    "n": best_n,
                    "u": best_u,
                    "preview": preview,
                    "qualityLevel": best_q,
                    "continuityOk": best_co,
                    "geometryVerified": best_gv,
                    "sourceClientCount": best_sc,
                    "accounts": (doc.get("accounts") or [])[-3:],
                    "clients": (doc.get("clients") or [])[-3:],
                })
            if len(recent_tables) >= max(1, int(limit_tables) or 48):
                break
        recent_tables.sort(key=lambda r: int(r.get("u") or 0), reverse=True)

        # Quality summary (recent days only, lightweight)
        qa = qb = qc = qd = unknown_boot = conflict = geom_fail = 0
        for d in days[:7]:
            day_path = self.root / d
            if not day_path.is_dir():
                continue
            for path in day_path.glob("*.json"):
                doc = self._read_doc(path)
                for bname, meta in (doc.get("boots") or {}).items():
                    if not isinstance(meta, dict):
                        continue
                    q = str(meta.get("q") or "C")
                    if q == "A":
                        qa += 1
                    elif q == "B":
                        qb += 1
                    elif q == "D":
                        qd += 1
                    else:
                        qc += 1
                    if is_unknown_boot(str(bname)):
                        unknown_boot += 1
                    reasons = meta.get("qr") or []
                    if "CLIENT_SEQUENCE_CONFLICT" in reasons:
                        conflict += 1
                    if not meta.get("gv"):
                        geom_fail += 1

        result = {
            "ok": True,
            "dayCount": len(days),
            "recentDays": days[:14],
            "tableFileCountRecent": table_files,
            "recentTables": recent_tables[: max(1, int(limit_tables) or 48)],
            "qualitySummary": {
                "A": qa,
                "B": qb,
                "C": qc,
                "D": qd,
                "unknownBoot": unknown_boot,
                "conflict": conflict,
                "geometryFail": geom_fail,
            },
            "root": str(self.root),
            "serverTime": int(now),
            "disclaimer": "统计结果仅描述已记录的历史样本。即使结果达到统计显著，也不表示未来结果会保持一致。",
        }
        _overview_cache = dict(result)
        _overview_cache_at = now
        return result
