# -*- coding: utf-8 -*-
"""Strict big-road formula replay + simple bet modes + optional plan stub."""
from __future__ import annotations

import hashlib
import json
import threading
import time
from typing import Any

from analytics_stats import (
    bootstrap_by_boots,
    jeffreys_mean,
    max_consecutive_loss,
    max_drawdown,
    walk_forward_days,
    wilson_interval,
)
from analytics_versions import (
    ANALYTICS_ALGORITHM_VERSION,
    BACKTEST_CACHE_TTL,
    BIG_ROAD_ALGORITHM_VERSION,
    DATA_SCHEMA_VERSION,
    PLAN_REPLAY_VERSION,
)
from big_road_engine import generate_big_road_from_chronological_seq, match_latest_columns, parse_pattern_columns
import analytics_db as adb

_backtest_lock = threading.Lock()
_backtest_busy = False


def resolve_bet_side(mode: str, tip_side: str) -> str:
    m = str(mode or "follow").strip().lower()
    tip = tip_side
    if tip in ("B", "P"):
        tip = "庄" if tip == "B" else "闲"
    if m in ("banker", "庄", "b"):
        return "庄"
    if m in ("player", "闲", "p"):
        return "闲"
    if m in ("against", "jump", "opposite", "反向", "跳"):
        return "闲" if tip == "庄" else "庄"
    return tip  # follow


def _outcome_from_bead(ch: str, bet_side: str) -> str:
    if ch == "T":
        return "TIE"
    side = "庄" if ch == "B" else "闲"
    return "WIN" if side == bet_side else "LOSE"


def dataset_hash(boots: list[dict[str, Any]]) -> str:
    parts = []
    for b in sorted(boots, key=lambda x: (x.get("day"), x.get("tableId"), x.get("bootNo"))):
        parts.append(
            f"{b.get('day')}|{b.get('tableId')}|{b.get('bootNo')}|{b.get('seqHash')}|{b.get('qualityLevel')}|{b.get('updatedAt')}"
        )
    return hashlib.sha256("\n".join(parts).encode("utf-8")).hexdigest()


def cache_get(key: str) -> dict[str, Any] | None:
    with adb._lock:
        conn = adb.get_conn()
        row = conn.execute(
            "SELECT result_json, expires_at FROM backtest_runs WHERE cache_key=?",
            (key,),
        ).fetchone()
        if not row:
            return None
        if int(row["expires_at"] or 0) < adb.now_ts():
            return None
        raw = row["result_json"]
    try:
        return json.loads(raw)
    except Exception:
        return None


def cache_put(key: str, result: dict[str, Any], meta: dict[str, Any]) -> None:
    now = adb.now_ts()
    payload = json.dumps(result, ensure_ascii=False)
    filters = json.dumps(meta.get("filters") or {}, ensure_ascii=False)
    with adb._lock:
        conn = adb.get_conn()
        conn.execute(
            """
            INSERT INTO backtest_runs(cache_key, created_at, expires_at, dataset_hash, formula_hash,
              plan_hash, algorithm_version, filters_json, result_json)
            VALUES(?,?,?,?,?,?,?,?,?)
            ON CONFLICT(cache_key) DO UPDATE SET
              created_at=excluded.created_at,
              expires_at=excluded.expires_at,
              result_json=excluded.result_json
            """,
            (
                key,
                now,
                now + BACKTEST_CACHE_TTL,
                meta.get("datasetHash"),
                meta.get("formulaHash"),
                meta.get("planHash"),
                ANALYTICS_ALGORITHM_VERSION,
                filters,
                payload,
            ),
        )
        conn.commit()


def strict_road_formula_winrate(
    boots: list[dict[str, Any]],
    *,
    pattern: str,
    bet_mode: str = "follow",
    plan: dict[str, Any] | None = None,
    quality_filter: str = "AB",
    include_heavy: bool = True,
) -> dict[str, Any]:
    """Strict physical big-road replay. boots items need day,tableId,bootNo,seq,qualityLevel,seqHash,updatedAt."""
    global _backtest_busy
    if not _backtest_lock.acquire(blocking=False):
        return {"ok": False, "message": "当前已有推演任务执行中，请稍后重试"}
    _backtest_busy = True
    try:
        parsed = parse_pattern_columns(pattern)
        if not parsed.get("ok"):
            return {"ok": False, "message": parsed.get("message") or "公式无效"}

        allowed = set("AB") if quality_filter.upper() == "AB" else set("ABC")
        scanned = [b for b in boots if str(b.get("qualityLevel") or "C") in allowed]
        excluded_d = sum(1 for b in boots if str(b.get("qualityLevel") or "") == "D")
        unknown_boot = sum(1 for b in boots if str(b.get("bootNo") or "_") in ("", "_"))
        qa = sum(1 for b in scanned if b.get("qualityLevel") == "A")
        qb = sum(1 for b in scanned if b.get("qualityLevel") == "B")
        qc = sum(1 for b in scanned if b.get("qualityLevel") == "C")

        dhash = dataset_hash(scanned)
        fhash = parsed["patternHash"]
        plan_hash = hashlib.sha256(json.dumps(plan or {}, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:32]
        filters = {"betMode": bet_mode, "qualityFilter": quality_filter, "hasPlan": bool(plan)}
        cache_key = hashlib.sha256(
            f"{dhash}|{fhash}|{plan_hash}|{json.dumps(filters, sort_keys=True)}|{ANALYTICS_ALGORITHM_VERSION}".encode()
        ).hexdigest()
        cached = cache_get(cache_key)
        if cached:
            cached = dict(cached)
            cached["cacheHit"] = True
            return cached

        win = lose = tie = unknown = 0
        triggers = 0
        dup_suppressed = 0
        unresolved = 0
        profits: list[float] = []
        results: list[str] = []
        stakes = 0.0
        seen_keys: set[str] = set()
        boot_buckets: dict[str, dict[str, Any]] = {}
        day_buckets: dict[str, dict[str, Any]] = {}
        tables: set[Any] = set()
        days: set[str] = set()

        # Plan mode: if plan provided, use simple follow-step amounts; else fixed 1 unit
        use_plan = bool(plan and plan.get("steps"))

        for boot in scanned:
            seq = str(boot.get("seq") or "")
            if not seq:
                continue
            day = str(boot.get("day") or "")
            tid = boot.get("tableId")
            boot_no = str(boot.get("bootNo") or "_")
            tables.add(tid)
            if day:
                days.add(day)
            grid = None
            # walk prefixes by decided beads only for trigger moments
            decided_prefix = []
            full_chars = list(seq)
            # Build incrementally after each B/P (T included in prefix string)
            prefix = ""
            for ch in full_chars:
                prefix += ch
                if ch not in ("B", "P"):
                    continue
                decided_prefix.append(ch)
                grid = generate_big_road_from_chronological_seq(prefix)
                m = match_latest_columns(grid, parsed["columns"])
                if not m.get("matched"):
                    continue
                tip_key = m.get("roadTipKey") or ""
                match_key = f"{tid}|{boot_no}|0|{parsed['patternHash']}|{tip_key}"
                if match_key in seen_keys:
                    dup_suppressed += 1
                    continue
                seen_keys.add(match_key)
                triggers += 1
                bet_side = resolve_bet_side(bet_mode, m.get("tipSide") or "")
                # settle on next non-T bead after this position
                rest = full_chars[len(prefix) :]
                outcome = None
                for nxt in rest:
                    if nxt == "T":
                        continue
                    outcome = _outcome_from_bead(nxt, bet_side)
                    break
                amount = 1.0
                if use_plan:
                    steps = plan.get("steps") or []
                    if steps:
                        amount = float(steps[0].get("amount") or 1)
                stakes += amount
                bk = f"{day}|{tid}|{boot_no}"
                bb = boot_buckets.setdefault(bk, {"win": 0, "lose": 0, "stake": 0.0, "profit": 0.0})
                dd = day_buckets.setdefault(day or "unknown", {"day": day or "unknown", "win": 0, "lose": 0, "stake": 0.0, "profit": 0.0})
                bb["stake"] += amount
                dd["stake"] += amount
                if outcome is None:
                    unresolved += 1
                    unknown += 1
                    results.append("UNKNOWN")
                    continue
                results.append(outcome)
                # Theoretical net: banker 0.95, player 1.0 — ONLY for historical replay estimate,
                # labeled as theoretical; not official netProfit.
                if outcome == "WIN":
                    win += 1
                    bb["win"] += 1
                    dd["win"] += 1
                    pnl = amount * (0.95 if bet_side == "庄" else 1.0)
                    profits.append(pnl)
                    bb["profit"] += pnl
                    dd["profit"] += pnl
                elif outcome == "LOSE":
                    lose += 1
                    bb["lose"] += 1
                    dd["lose"] += 1
                    profits.append(-amount)
                    bb["profit"] -= amount
                    dd["profit"] -= amount
                elif outcome == "TIE":
                    tie += 1
                    profits.append(0.0)
                else:
                    unknown += 1

        decided = win + lose
        wil = wilson_interval(win, lose)
        bay = jeffreys_mean(win, lose)
        heavy = bootstrap_by_boots(list(boot_buckets.values())) if include_heavy else {
            "bootstrapSamples": 0,
            "bootstrapWinRateLower95": None,
            "bootstrapWinRateUpper95": None,
            "bootstrapRoiLower95": None,
            "bootstrapRoiUpper95": None,
        }
        wf = walk_forward_days(list(day_buckets.values())) if include_heavy else {
            "walkForwardWindowCount": 0,
            "walkForwardDecided": 0,
            "walkForwardWinRate": None,
            "walkForwardRoi": None,
            "walkForwardStability": None,
        }
        net = sum(profits) if profits else 0.0
        result = {
            "ok": True,
            "pattern": parsed.get("normalized"),
            "patternHash": fhash,
            "betMode": bet_mode,
            "algorithm": "strict-physical-big-road",
            "algorithmVersion": ANALYTICS_ALGORITHM_VERSION,
            "bigRoadAlgorithmVersion": BIG_ROAD_ALGORITHM_VERSION,
            "planReplayVersion": PLAN_REPLAY_VERSION if use_plan else None,
            "planHash": plan_hash if use_plan else None,
            "planProvided": use_plan,
            "replayMode": "FULL_PLAN" if use_plan else "UNIT_DIRECTION",
            "replayModeLabel": "完整下注计划历史回放" if use_plan else "固定单位理论回放",
            "profitType": "THEORETICAL",
            "dataSchemaVersion": DATA_SCHEMA_VERSION,
            "datasetHash": dhash,
            "cacheHit": False,
            "matches": triggers,
            "geometricTriggerCount": triggers,
            "duplicateTriggerSuppressed": dup_suppressed,
            "unresolvedTriggerCount": unresolved,
            "win": win,
            "lose": lose,
            "tie": tie,
            "unknown": unknown,
            "decided": decided,
            "rawWinRate": wil["rawWinRate"],
            "winRate": wil["rawWinRate"],
            "winRatePct": None if wil["rawWinRate"] is None else round(wil["rawWinRate"] * 1000) / 10,
            **{k: wil[k] for k in ("wilsonLower", "wilsonUpper", "wilsonLowerPct", "wilsonUpperPct")},
            **bay,
            "totalStake": stakes,
            "netProfit": net,
            "roi": (net / stakes) if stakes else None,
            "maxDrawdown": max_drawdown(profits) if profits else None,
            "maxConsecutiveLoss": max_consecutive_loss(results),
            "profitCoveragePct": 100.0,
            "profitNote": "推演净盈亏为理论估算（庄 0.95 / 闲 1），不是官方派彩字段",
            "bootsScanned": len(scanned),
            "tableCount": len(tables),
            "tableCountScanned": len(tables),
            "bootCountScanned": len(scanned),
            "dayCount": len(days),
            "qualityACount": qa,
            "qualityBCount": qb,
            "qualityCCount": qc,
            "excludedDCount": excluded_d,
            "unknownBootExcludedCount": unknown_boot if quality_filter.upper() == "AB" else 0,
            "conflictExcludedCount": excluded_d,
            "dataQualityFilter": quality_filter,
            **heavy,
            **{k: wf[k] for k in wf if str(k).startswith("walkForward")},
            "note": "本结果为历史数据回放，不代表未来结果。胜率=赢/(赢+输)，和局不计。",
            "disclaimer": "统计结果仅描述已记录的历史样本。即使结果达到统计显著，也不表示未来结果会保持一致。",
        }
        cache_put(cache_key, result, {
            "datasetHash": dhash,
            "formulaHash": fhash,
            "planHash": plan_hash,
            "filters": filters,
        })
        return result
    finally:
        _backtest_busy = False
        _backtest_lock.release()
