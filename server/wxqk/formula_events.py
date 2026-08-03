# -*- coding: utf-8 -*-
"""Structured formula event ingest, migration, and SQLite aggregation."""
from __future__ import annotations

import hashlib
import json
import time
from pathlib import Path
from typing import Any

import analytics_db as adb
from analytics_stats import (
    benjamini_hochberg,
    bootstrap_by_boots,
    conclusion_label,
    jeffreys_mean,
    max_consecutive_loss,
    max_drawdown,
    one_sided_binomial_p,
    walk_forward_days,
    wilson_interval,
)
from analytics_versions import ANALYTICS_ALGORITHM_VERSION, DATA_SCHEMA_VERSION

PLACE_CODES = {"PLACE_OK", "PLACE_BLOCKED", "PLACE_FAILED"}
SETTLE_CODES = {"SETTLE_OK", "SETTLE_UNKNOWN"}


def make_event_id(ev: dict[str, Any]) -> str:
    tx = str(ev.get("betTransactionId") or "").strip()
    parts = [
        str(ev.get("schemaVersion") or DATA_SCHEMA_VERSION),
        str(ev.get("clientId") or ""),
        str(ev.get("accountHash") or ""),
        tx,
        str(ev.get("code") or "").upper(),
        "1" if ev.get("simulated") else "0",
        str(ev.get("formulaId") or ev.get("patternHash") or ev.get("patternText") or ""),
        str(ev.get("slot") or 0),
    ]
    if not tx:
        parts.extend([
            str(ev.get("occurredAt") or ev.get("occurred_at") or ""),
            str(ev.get("tableId") or ""),
            str(ev.get("roundId") or ""),
        ])
    raw = "|".join(parts)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _as_bool(v: Any) -> int:
    if isinstance(v, bool):
        return 1 if v else 0
    s = str(v or "").strip().lower()
    return 1 if s in ("1", "true", "yes", "y") else 0


def ingest_formula_events(events: list[dict[str, Any]], *, ip: str = "", source: str = "live") -> dict[str, Any]:
    """Insert formula events into SQLite (authoritative). Caller may append JSONL after success.

    Returns received/inserted/duplicate/invalid counters. Does not write JSONL.
    """
    received = len(events or [])
    if not events:
        return {
            "ok": True,
            "received": 0,
            "inserted": 0,
            "duplicate": 0,
            "invalid": 0,
            "accepted": 0,
            "ignored": 0,
            "jsonlFailed": 0,
        }
    inserted = 0
    duplicate = 0
    invalid = 0
    now = adb.now_ts()
    rows = []
    for raw in events:
        if not isinstance(raw, dict):
            invalid += 1
            continue
        code = str(raw.get("code") or "").strip().upper()
        if code not in PLACE_CODES and code not in SETTLE_CODES:
            invalid += 1
            continue
        formula_id = str(raw.get("formulaId") or raw.get("patternHash") or raw.get("patternText") or "").strip()
        if not formula_id:
            invalid += 1
            continue
        ev = dict(raw)
        ev["code"] = code
        ev.setdefault("ip", ip)
        ev.setdefault("schemaVersion", DATA_SCHEMA_VERSION)
        event_id = str(raw.get("eventId") or "").strip() or make_event_id(ev)
        occurred = raw.get("occurredAt") or raw.get("occurred_at")
        try:
            occurred_at = int(occurred) if occurred is not None and str(occurred).isdigit() else None
        except Exception:
            occurred_at = None
        if occurred_at is None:
            occurred_at = now
        conf = str(raw.get("settlementConfidence") or raw.get("settlement_confidence") or "CONFIRMED")
        if source == "legacy_import":
            conf = "LEGACY"
        net = raw.get("netProfit")
        if net is None:
            net = raw.get("net_profit")
        try:
            net_profit = float(net) if net is not None and str(net) != "" else None
        except Exception:
            net_profit = None
        rows.append((
            event_id,
            int(raw.get("schemaVersion") or DATA_SCHEMA_VERSION),
            str(raw.get("algorithmVersion") or ANALYTICS_ALGORITHM_VERSION),
            occurred_at,
            now,
            str(raw.get("clientId") or "")[:80],
            str(raw.get("accountHash") or "")[:64],
            str(raw.get("maskedAccount") or raw.get("account") or "")[:40],
            str(raw.get("ip") or ip or "")[:64],
            formula_id[:120],
            str(raw.get("patternText") or "")[:120],
            str(raw.get("patternHash") or "")[:120],
            int(raw.get("slot") or 0) or 0,
            str(raw.get("betTransactionId") or "")[:120],
            code,
            _as_bool(raw.get("simulated")),
            int(raw.get("tableId") or 0) or 0,
            str(raw.get("tableTitle") or "")[:80],
            str(raw.get("category") or "")[:8],
            str(raw.get("bootNo") or raw.get("boot") or "")[:40],
            int(raw.get("roundId") or 0) or None,
            str(raw.get("shoeId") or "")[:40],
            str(raw.get("betSide") or "")[:20],
            int(raw.get("betPointId") or 0) or None,
            float(raw.get("betAmount") or 0) or None,
            str(raw.get("gameResult") or "").upper()[:20] or None,
            net_profit,
            float(raw.get("payoutRatio") or 0) or None,
            str(raw.get("settlementSource") or "")[:40],
            conf[:20],
            str(raw.get("unknownReason") or "")[:80],
            source,
        ))
    if not rows and invalid:
        return {
            "ok": False,
            "received": received,
            "inserted": 0,
            "duplicate": 0,
            "invalid": invalid,
            "accepted": 0,
            "ignored": invalid,
            "jsonlFailed": 0,
            "message": "no_valid_events",
        }
    conn = adb.get_conn()
    with adb._lock:
        before = conn.total_changes
        conn.executemany(
            """
            INSERT OR IGNORE INTO formula_events(
              event_id, schema_version, algorithm_version, occurred_at, uploaded_at,
              client_id, account_hash, masked_account, ip, formula_id, pattern_text, pattern_hash,
              slot, bet_transaction_id, code, simulated, table_id, table_title, category,
              boot_no, round_id, shoe_id, bet_side, bet_point_id, bet_amount, game_result,
              net_profit, payout_ratio, settlement_source, settlement_confidence, unknown_reason, source
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            """,
            rows,
        )
        conn.commit()
        inserted = conn.total_changes - before
        duplicate = len(rows) - inserted
    return {
        "ok": True,
        "received": received,
        "inserted": inserted,
        "duplicate": duplicate,
        "invalid": invalid,
        "accepted": inserted,
        "ignored": duplicate + invalid,
        "jsonlFailed": 0,
    }


def finalize_ingest_response(sqlite_result: dict[str, Any], *, jsonl_failed: int = 0) -> dict[str, Any]:
    """Attach JSONL audit status without changing SQLite authority / ok flag."""
    out = dict(sqlite_result or {})
    out["jsonlFailed"] = max(0, int(jsonl_failed or 0))
    return out


def migrate_formula_jsonl(path: Path) -> dict[str, Any]:
    """Idempotent migration from formula/events.jsonl → SQLite."""
    if adb.get_meta("formula_events_migrated") == "1":
        return {"ok": True, "skipped": True, "imported": 0, "failed": 0}
    if not path.exists():
        adb.set_meta("formula_events_migrated", "1")
        return {"ok": True, "skipped": True, "imported": 0, "failed": 0, "note": "no jsonl"}
    imported = 0
    failed = 0
    batch: list[dict[str, Any]] = []
    try:
        with path.open("r", encoding="utf-8", errors="replace") as f:
            for ln in f:
                ln = ln.strip()
                if not ln:
                    continue
                try:
                    row = json.loads(ln)
                except Exception:
                    failed += 1
                    continue
                if not isinstance(row, dict):
                    failed += 1
                    continue
                batch.append({
                    "code": row.get("code"),
                    "clientId": row.get("clientId"),
                    "ip": row.get("ip"),
                    "formulaId": row.get("patternHash") or row.get("formula"),
                    "patternText": row.get("patternText") or row.get("formula"),
                    "patternHash": row.get("patternHash"),
                    "slot": row.get("slot"),
                    "simulated": row.get("simulated"),
                    "betTransactionId": row.get("betTransactionId"),
                    "gameResult": row.get("gameResult"),
                    "betAmount": row.get("betAmount"),
                    "betSide": row.get("betSide"),
                    "tableId": row.get("tableId"),
                    "tableTitle": row.get("tableTitle"),
                    "occurredAt": None,
                    "settlementConfidence": "LEGACY",
                })
                if len(batch) >= 500:
                    r = ingest_formula_events(batch, source="legacy_import")
                    imported += int(r.get("accepted") or 0)
                    batch = []
        if batch:
            r = ingest_formula_events(batch, source="legacy_import")
            imported += int(r.get("accepted") or 0)
        adb.set_meta("formula_events_migrated", "1")
        adb.set_meta("formula_events_migrated_count", str(imported))
        return {"ok": True, "imported": imported, "failed": failed}
    except Exception as e:
        return {"ok": False, "imported": imported, "failed": failed, "error": str(e)[:200]}


def aggregate_from_db(
    *,
    ip: str = "",
    client_id: str = "",
    account_hash: str = "",
    include_heavy: bool = False,
) -> dict[str, Any]:
    """Aggregate formula stats from SQLite (full history, not 8MB tail)."""
    conn = adb.get_conn()
    where = ["1=1"]
    args: list[Any] = []
    if ip:
        where.append("ip=?")
        args.append(ip)
    if client_id:
        where.append("client_id=?")
        args.append(client_id)
    if account_hash:
        where.append("account_hash=?")
        args.append(account_hash)
    sql = f"SELECT * FROM formula_events WHERE {' AND '.join(where)} ORDER BY occurred_at ASC"
    rows = conn.execute(sql, args).fetchall()

    buckets: dict[str, dict[str, Any]] = {}
    for r in rows:
        formula = str(r["formula_id"] or r["pattern_text"] or "")
        slot = int(r["slot"] or 0)
        sim = int(r["simulated"] or 0)
        key = f"{formula}|{slot}|{sim}"
        b = buckets.setdefault(key, {
            "formula": formula,
            "patternHash": r["pattern_hash"] or "",
            "slot": slot,
            "simulated": sim,
            "placeReal": 0, "placeSim": 0,
            "placeBlocked": 0, "placeFailed": 0,
            "win": 0, "lose": 0, "tie": 0, "unknown": 0,
            "winReal": 0, "loseReal": 0, "tieReal": 0,
            "winSim": 0, "loseSim": 0, "tieSim": 0,
            "placeSuccess": 0,
            "profits": [],
            "results": [],
            "boots": {},
            "days": {},
            "lastAt": 0,
            "legacy": 0,
            "profitKnown": 0,
            "profitUnknown": 0,
            "dataInconsistent": False,
        })
        code = str(r["code"] or "").upper()
        gr = str(r["game_result"] or "").upper()
        is_sim = bool(sim)
        if code == "PLACE_OK":
            b["placeSuccess"] += 1
            if is_sim:
                b["placeSim"] += 1
            else:
                b["placeReal"] += 1
        elif code == "PLACE_BLOCKED":
            b["placeBlocked"] += 1
        elif code == "PLACE_FAILED":
            b["placeFailed"] += 1
        elif code in SETTLE_CODES:
            if gr == "WIN":
                b["win"] += 1
                if is_sim:
                    b["winSim"] += 1
                else:
                    b["winReal"] += 1
                b["results"].append("WIN")
            elif gr == "LOSE":
                b["lose"] += 1
                if is_sim:
                    b["loseSim"] += 1
                else:
                    b["loseReal"] += 1
                b["results"].append("LOSE")
            elif gr == "TIE":
                b["tie"] += 1
                if is_sim:
                    b["tieSim"] += 1
                else:
                    b["tieReal"] += 1
                b["results"].append("TIE")
            else:
                b["unknown"] += 1
                b["results"].append("UNKNOWN")
            if r["net_profit"] is not None:
                b["profits"].append(float(r["net_profit"]))
                b["profitKnown"] += 1
            else:
                b["profitUnknown"] += 1
            day = time.strftime("%Y-%m-%d", time.gmtime((r["occurred_at"] or 0) + 8 * 3600)) if r["occurred_at"] else ""
            boot = f"{day}|{r['table_id']}|{r['boot_no'] or '_'}"
            bb = b["boots"].setdefault(boot, {"win": 0, "lose": 0, "stake": 0.0, "profit": 0.0})
            if gr == "WIN":
                bb["win"] += 1
            elif gr == "LOSE":
                bb["lose"] += 1
            if r["bet_amount"] is not None:
                bb["stake"] += float(r["bet_amount"] or 0)
            if r["net_profit"] is not None:
                bb["profit"] += float(r["net_profit"])
            dd = b["days"].setdefault(day or "unknown", {"day": day or "unknown", "win": 0, "lose": 0, "stake": 0.0, "profit": 0.0})
            if gr == "WIN":
                dd["win"] += 1
            elif gr == "LOSE":
                dd["lose"] += 1
            if r["bet_amount"] is not None:
                dd["stake"] += float(r["bet_amount"] or 0)
            if r["net_profit"] is not None:
                dd["profit"] += float(r["net_profit"])
        if r["settlement_confidence"] == "LEGACY":
            b["legacy"] += 1
        if r["occurred_at"] and int(r["occurred_at"]) > int(b["lastAt"] or 0):
            b["lastAt"] = int(r["occurred_at"])

    out_rows = []
    pvals = []
    for b in buckets.values():
        settled = b["win"] + b["lose"] + b["tie"] + b["unknown"]
        unresolved = b["placeSuccess"] - settled
        if unresolved < 0:
            b["dataInconsistent"] = True
        decided = b["win"] + b["lose"]
        wil = wilson_interval(b["win"], b["lose"])
        bay = jeffreys_mean(b["win"], b["lose"])
        stake = sum(float(x.get("stake") or 0) for x in b["boots"].values())
        profit = sum(b["profits"]) if b["profits"] else None
        coverage = (
            b["profitKnown"] / (b["profitKnown"] + b["profitUnknown"])
            if (b["profitKnown"] + b["profitUnknown"]) else None
        )
        roi_partial = False
        if profit is not None and stake > 0 and coverage is not None:
            if coverage >= 0.95:
                roi = profit / stake
            else:
                roi = None
                roi_partial = True
        else:
            roi = None
        dd = max_drawdown(b["profits"]) if b["profits"] and coverage and coverage >= 0.95 else None
        mcl = max_consecutive_loss(b["results"])
        boots_list = list(b["boots"].values())
        boot_stats = bootstrap_by_boots(boots_list) if include_heavy else {
            "bootstrapSamples": 0,
            "bootstrapWinRateLower95": None,
            "bootstrapWinRateUpper95": None,
            "bootstrapRoiLower95": None,
            "bootstrapRoiUpper95": None,
        }
        wf = walk_forward_days(list(b["days"].values())) if include_heavy else {
            "walkForwardWindowCount": 0,
            "walkForwardDecided": 0,
            "walkForwardWinRate": None,
            "walkForwardRoi": None,
            "walkForwardStability": None,
            "walkForwardWindows": [],
        }
        p = one_sided_binomial_p(b["win"], b["lose"], 0.5)
        pvals.append(p if p is not None else 1.0)
        real_dec = b["winReal"] + b["loseReal"]
        sim_dec = b["winSim"] + b["loseSim"]
        if b["dataInconsistent"] or decided < 30:
            significance_basis = "NOT_AVAILABLE"
        elif coverage is not None and coverage >= 0.95 and profit is not None:
            significance_basis = "NET_PROFIT"
        else:
            significance_basis = "WIN_RATE"
        out_rows.append({
            "formula": b["formula"],
            "patternHash": b["patternHash"],
            "slot": b["slot"],
            "simulated": bool(b["simulated"]),
            "placeReal": b["placeReal"],
            "placeSim": b["placeSim"],
            "placeTotal": b["placeReal"] + b["placeSim"],
            "placeAttemptCount": b["placeSuccess"] + b["placeBlocked"] + b["placeFailed"],
            "placeBlockedCount": b["placeBlocked"],
            "placeFailedCount": b["placeFailed"],
            "placeSuccessCount": b["placeSuccess"],
            "triggerCount": b["placeSuccess"],
            "win": b["win"],
            "lose": b["lose"],
            "tie": b["tie"],
            "unknown": b["unknown"],
            "unresolved": unresolved,
            "settledCount": settled,
            "decided": decided,
            "rawWinRate": wil["rawWinRate"],
            "winReal": b["winReal"],
            "loseReal": b["loseReal"],
            "tieReal": b["tieReal"],
            "winSim": b["winSim"],
            "loseSim": b["loseSim"],
            "tieSim": b["tieSim"],
            "winRate": wil["rawWinRate"],
            "winRatePct": None if wil["rawWinRate"] is None else round(wil["rawWinRate"] * 1000) / 10,
            "winRateReal": (b["winReal"] / real_dec) if real_dec else None,
            "winRateRealPct": None if real_dec <= 0 else round((b["winReal"] / real_dec) * 1000) / 10,
            "winRateSim": (b["winSim"] / sim_dec) if sim_dec else None,
            "winRateSimPct": None if sim_dec <= 0 else round((b["winSim"] / sim_dec) * 1000) / 10,
            **{k: wil[k] for k in ("wilsonLower", "wilsonUpper", "wilsonLowerPct", "wilsonUpperPct")},
            **bay,
            "totalStake": stake if stake else None,
            "netProfit": profit,
            "roi": roi,
            "roiPartial": roi_partial,
            "maxDrawdown": dd,
            "maxConsecutiveLoss": mcl,
            "profitKnownCount": b["profitKnown"],
            "profitUnknownCount": b["profitUnknown"],
            "profitCoveragePct": None if coverage is None else round(coverage * 1000) / 10,
            "bootCount": len(b["boots"]),
            "dayCount": len([d for d in b["days"] if d != "unknown"]),
            "legacyCount": b["legacy"],
            "containsLegacyImport": b["legacy"] > 0,
            "dataInconsistent": b["dataInconsistent"],
            "dataQuality": "C" if b["legacy"] else "B",
            "significanceBasis": significance_basis,
            "lastAt": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(b["lastAt"])) if b["lastAt"] else "",
            **boot_stats,
            **{k: wf[k] for k in wf if str(k).startswith("walkForward")},
            "_pValue": p,
            "_coverage": coverage,
        })

    fdr = benjamini_hochberg([r["_pValue"] if r["_pValue"] is not None else 1.0 for r in out_rows])
    for i, r in enumerate(out_rows):
        info = fdr[i] if i < len(fdr) else {}
        r["pValue"] = info.get("pValue")
        r["qValue"] = info.get("qValue")
        r["fdrSignificant"] = bool(info.get("fdrSignificant"))
        cov = r.pop("_coverage", None)
        r["conclusion"] = conclusion_label(
            decided=int(r["decided"] or 0),
            boot_count=int(r["bootCount"] or 0),
            day_count=int(r["dayCount"] or 0),
            q_value=r.get("qValue"),
            wilson_lower=r.get("wilsonLower"),
            walk_stability=r.get("walkForwardStability"),
            strict_ratio=None,
            roi=r.get("roi"),
            bootstrap_roi_lo=r.get("bootstrapRoiLower95"),
            data_inconsistent=bool(r.get("dataInconsistent")),
            profit_coverage=cov,
        )
        if r.get("significanceBasis") == "WIN_RATE":
            r["significanceHint"] = "当前显著性基于胜负比例，不等同于实际盈利能力。"
        elif r.get("significanceBasis") == "NET_PROFIT":
            r["significanceHint"] = "盈利能力检验（净盈亏覆盖率足够）"
        else:
            r["significanceHint"] = "暂不可检验"
        r["wilsonLowerSort"] = r["wilsonLower"] if r["wilsonLower"] is not None else -1
        del r["_pValue"]

    out_rows.sort(key=lambda x: (
        0 if x.get("conclusion") == "历史样本中表现较稳" else 1,
        0 if int(x.get("decided") or 0) >= 100 else 1,
        0 if x.get("fdrSignificant") else 1,
        -(x.get("wilsonLowerSort") or -1),
        -(int(x.get("decided") or 0)),
    ))
    return {
        "ok": True,
        "rows": out_rows,
        "eventCount": len(rows),
        "uniqueEvents": len(rows),
        "updatedAt": time.strftime("%Y-%m-%d %H:%M:%S"),
        "algorithmVersion": ANALYTICS_ALGORITHM_VERSION,
        "dataSchemaVersion": DATA_SCHEMA_VERSION,
        "source": "analytics.db",
        "disclaimer": "统计结果仅描述已记录的历史样本。即使结果达到统计显著，也不表示未来结果会保持一致。",
        "scope": {"ip": ip or "", "clientId": client_id or "", "all": not ip and not client_id},
        "containsLegacyImport": any(r.get("containsLegacyImport") for r in out_rows),
    }


def aggregate_tables_for_client(client_id: str, *, limit_events: int = 80_000) -> dict[str, Any]:
    """Per-table win/lose/tie for one client from formula_events (real + sim)."""
    cid = str(client_id or "").strip()
    if not cid:
        return {"ok": True, "rows": [], "recent": [], "eventCount": 0}
    conn = adb.get_conn()
    rows = conn.execute(
        """
        SELECT table_id, table_title, code, game_result, simulated, bet_amount, bet_side,
               pattern_text, slot, occurred_at
        FROM formula_events
        WHERE client_id=?
        ORDER BY occurred_at DESC
        LIMIT ?
        """,
        (cid, max(1, min(int(limit_events or 80_000), 200_000))),
    ).fetchall()
    buckets: dict[str, dict[str, Any]] = {}
    recent: list[dict[str, Any]] = []
    for r in rows:
        code = str(r["code"] or "").upper()
        tid = int(r["table_id"] or 0) or 0
        title = str(r["table_title"] or "").strip()
        gr = str(r["game_result"] or "").upper()
        sim = int(r["simulated"] or 0)
        key = str(tid)
        b = buckets.setdefault(key, {
            "tableId": tid,
            "tableTitle": title,
            "win": 0, "lose": 0, "tie": 0, "unknown": 0,
            "winReal": 0, "loseReal": 0, "tieReal": 0,
            "winSim": 0, "loseSim": 0, "tieSim": 0,
            "placeReal": 0, "placeSim": 0,
            "betAmountSum": 0.0,
        })
        if title and not b.get("tableTitle"):
            b["tableTitle"] = title
        if code in PLACE_CODES and code == "PLACE_OK":
            if sim:
                b["placeSim"] += 1
            else:
                b["placeReal"] += 1
            try:
                b["betAmountSum"] += float(r["bet_amount"] or 0)
            except Exception:
                pass
        if code in SETTLE_CODES:
            recent.append({
                "tableId": tid,
                "tableTitle": title or b.get("tableTitle") or "",
                "gameResult": gr,
                "simulated": bool(sim),
                "betSide": str(r["bet_side"] or ""),
                "betAmount": float(r["bet_amount"] or 0) if r["bet_amount"] is not None else 0,
                "patternText": str(r["pattern_text"] or ""),
                "slot": int(r["slot"] or 0) or 0,
                "occurredAt": int(r["occurred_at"] or 0) or 0,
            })
            if gr == "WIN":
                b["win"] += 1
                if sim:
                    b["winSim"] += 1
                else:
                    b["winReal"] += 1
            elif gr == "LOSE":
                b["lose"] += 1
                if sim:
                    b["loseSim"] += 1
                else:
                    b["loseReal"] += 1
            elif gr == "TIE":
                b["tie"] += 1
                if sim:
                    b["tieSim"] += 1
                else:
                    b["tieReal"] += 1
            else:
                b["unknown"] += 1
    out_rows = []
    for b in buckets.values():
        decided = int(b["win"]) + int(b["lose"])
        b["decided"] = decided
        b["total"] = decided + int(b["tie"]) + int(b["unknown"])
        b["winRatePct"] = round(100.0 * b["win"] / decided, 1) if decided else None
        out_rows.append(b)
    out_rows.sort(key=lambda x: (-(x["win"] + x["lose"] + x["tie"]), -(x.get("tableId") or 0)))
    return {
        "ok": True,
        "rows": out_rows,
        "recent": recent[:120],
        "eventCount": len(rows),
    }
