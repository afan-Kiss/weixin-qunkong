# -*- coding: utf-8 -*-
"""Statistical helpers: Wilson, Jeffreys mean, Bootstrap, FDR, Walk-forward."""
from __future__ import annotations

import math
import random
from typing import Any

Z95 = 1.959963984540054


def wilson_interval(win: int, lose: int, z: float = Z95) -> dict[str, Any]:
    n = int(win) + int(lose)
    if n <= 0:
        return {
            "wilsonLower": None,
            "wilsonUpper": None,
            "wilsonLowerPct": None,
            "wilsonUpperPct": None,
            "rawWinRate": None,
        }
    p = win / n
    z2 = z * z
    denom = 1 + z2 / n
    center = p + z2 / (2 * n)
    margin = z * math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)
    lo = max(0.0, (center - margin) / denom)
    hi = min(1.0, (center + margin) / denom)
    return {
        "wilsonLower": lo,
        "wilsonUpper": hi,
        "wilsonLowerPct": round(lo * 1000) / 10,
        "wilsonUpperPct": round(hi * 1000) / 10,
        "rawWinRate": p,
    }


def jeffreys_mean(win: int, lose: int) -> dict[str, Any]:
    """Jeffreys prior Beta(win+0.5, lose+0.5). Interval left NULL without SciPy."""
    w, l = int(win), int(lose)
    if w + l <= 0:
        return {
            "bayesMean": None,
            "bayesLower95": None,
            "bayesUpper95": None,
            "bayesIntervalAvailable": False,
            "bayesIntervalNote": "Beta quantiles not computed without SciPy; mean only",
        }
    return {
        "bayesMean": (w + 0.5) / (w + l + 1.0),
        "bayesLower95": None,
        "bayesUpper95": None,
        "bayesIntervalAvailable": False,
        "bayesIntervalNote": "Beta quantiles not computed without SciPy; mean only",
    }


def max_drawdown(profits: list[float]) -> float:
    equity = 0.0
    peak = 0.0
    max_dd = 0.0
    for p in profits:
        equity += float(p)
        if equity > peak:
            peak = equity
        dd = peak - equity
        if dd > max_dd:
            max_dd = dd
    return max_dd


def max_consecutive_loss(results: list[str]) -> int:
    """LOSE streaks; TIE does not break streak (project rule)."""
    best = 0
    cur = 0
    for r in results:
        u = str(r or "").upper()
        if u == "LOSE":
            cur += 1
            best = max(best, cur)
        elif u == "WIN":
            cur = 0
        # TIE / UNKNOWN: do not break
    return best


def bootstrap_by_boots(
    boots: list[dict[str, Any]],
    *,
    samples: int = 1000,
    seed: int = 20260724,
) -> dict[str, Any]:
    """boots: [{win, lose, stake, profit}] — resample whole boots."""
    if len(boots) < 5:
        return {
            "bootstrapSamples": 0,
            "bootstrapWinRateLower95": None,
            "bootstrapWinRateUpper95": None,
            "bootstrapRoiLower95": None,
            "bootstrapRoiUpper95": None,
        }
    rng = random.Random(seed)
    n = len(boots)
    wr_samples: list[float] = []
    roi_samples: list[float] = []
    for _ in range(int(samples)):
        pick = [boots[rng.randrange(n)] for _ in range(n)]
        w = sum(int(b.get("win") or 0) for b in pick)
        l = sum(int(b.get("lose") or 0) for b in pick)
        stake = sum(float(b.get("stake") or 0) for b in pick)
        profit = sum(float(b.get("profit") or 0) for b in pick)
        decided = w + l
        if decided > 0:
            wr_samples.append(w / decided)
        if stake > 0:
            roi_samples.append(profit / stake)
    wr_samples.sort()
    roi_samples.sort()

    def pct(arr: list[float], q: float) -> float | None:
        if not arr:
            return None
        i = max(0, min(len(arr) - 1, int(round((len(arr) - 1) * q))))
        return arr[i]

    return {
        "bootstrapSamples": int(samples),
        "bootstrapWinRateLower95": pct(wr_samples, 0.025),
        "bootstrapWinRateUpper95": pct(wr_samples, 0.975),
        "bootstrapRoiLower95": pct(roi_samples, 0.025),
        "bootstrapRoiUpper95": pct(roi_samples, 0.975),
    }


def benjamini_hochberg(p_values: list[float], alpha: float = 0.05) -> list[dict[str, Any]]:
    """Return list of {index, pValue, qValue, fdrSignificant}."""
    indexed = [(i, float(p)) for i, p in enumerate(p_values)]
    indexed.sort(key=lambda x: x[1])
    m = len(indexed)
    out = [{"index": i, "pValue": None, "qValue": None, "fdrSignificant": False} for i in range(m)]
    if m == 0:
        return out
    prev_q = 1.0
    ranks = list(range(m, 0, -1))
    q_map: dict[int, float] = {}
    for rank, (idx, p) in zip(ranks, reversed(indexed)):
        q = min(prev_q, p * m / rank)
        prev_q = q
        q_map[idx] = q
    # forward pass for BH significance: largest k with p_(k) <= alpha*k/m
    thresh_rank = 0
    for rank, (idx, p) in enumerate(indexed, start=1):
        if p <= alpha * rank / m:
            thresh_rank = rank
    significant = {indexed[i][0] for i in range(thresh_rank)}
    for i in range(m):
        out[i] = {
            "index": i,
            "pValue": float(p_values[i]),
            "qValue": q_map.get(i),
            "fdrSignificant": i in significant,
        }
    return out


def one_sided_binomial_p(win: int, lose: int, p0: float = 0.5) -> float | None:
    """Exact one-sided binomial p-value P(X>=win) under H0 p=p0. Small-n exact."""
    n = win + lose
    if n <= 0:
        return None
    # Use normal approx with continuity for large n; exact for small
    if n > 200:
        mean = n * p0
        var = n * p0 * (1 - p0)
        if var <= 0:
            return None
        z = (win - 0.5 - mean) / math.sqrt(var)
        # 1 - Phi(z)
        return 0.5 * math.erfc(z / math.sqrt(2))
    # Exact
    from math import comb

    total = 0.0
    for k in range(win, n + 1):
        total += comb(n, k) * (p0**k) * ((1 - p0) ** (n - k))
    return min(1.0, total)


def walk_forward_days(
    day_stats: list[dict[str, Any]],
    *,
    train_days: int = 7,
    test_days: int = 1,
) -> dict[str, Any]:
    """day_stats sorted by day: [{day, win, lose, stake, profit}].

    Train window is unused for formula selection (single formula replay);
    only the forward validation day contributes to metrics. Test day never
    enters any earlier window's training slice.
    """
    rows = sorted(day_stats, key=lambda r: str(r.get("day") or ""))
    if len(rows) < 10:
        return {
            "walkForwardWindowCount": 0,
            "walkForwardDecided": 0,
            "walkForwardWinRate": None,
            "walkForwardRoi": None,
            "walkForwardPositiveWindowCount": 0,
            "walkForwardNegativeWindowCount": 0,
            "walkForwardStability": None,
            "walkForwardWindows": [],
            "walkForwardNote": "需要至少 10 个有数据日期",
        }
    windows = 0
    tw = tl = 0
    tstake = 0.0
    tprofit = 0.0
    pos = neg = 0
    window_meta: list[dict[str, Any]] = []
    i = 0
    while i + train_days + test_days <= len(rows):
        train = rows[i : i + train_days]
        test = rows[i + train_days : i + train_days + test_days]
        w = sum(int(r.get("win") or 0) for r in test)
        l = sum(int(r.get("lose") or 0) for r in test)
        stake = sum(float(r.get("stake") or 0) for r in test)
        profit = sum(float(r.get("profit") or 0) for r in test)
        decided = w + l
        if decided > 0 or stake > 0:
            windows += 1
            tw += w
            tl += l
            tstake += stake
            tprofit += profit
            if profit > 0:
                pos += 1
            elif profit < 0:
                neg += 1
            window_meta.append({
                "trainFrom": str(train[0].get("day") or ""),
                "trainTo": str(train[-1].get("day") or ""),
                "testFrom": str(test[0].get("day") or ""),
                "testTo": str(test[-1].get("day") or ""),
                "win": w,
                "lose": l,
                "stake": stake,
                "profit": profit,
            })
        i += 1  # roll forward 1 day
    decided = tw + tl
    return {
        "walkForwardWindowCount": windows,
        "walkForwardDecided": decided,
        "walkForwardWinRate": (tw / decided) if decided else None,
        "walkForwardRoi": (tprofit / tstake) if tstake > 0 else None,
        "walkForwardPositiveWindowCount": pos,
        "walkForwardNegativeWindowCount": neg,
        "walkForwardStability": (pos / windows) if windows else None,
        "walkForwardWindows": window_meta,
    }


def conclusion_label(
    *,
    decided: int,
    boot_count: int,
    day_count: int,
    q_value: float | None,
    wilson_lower: float | None,
    walk_stability: float | None,
    strict_ratio: float | None,
    roi: float | None,
    bootstrap_roi_lo: float | None,
    baseline: float = 0.5,
    data_inconsistent: bool = False,
    profit_coverage: float | None = None,
) -> str:
    if data_inconsistent:
        return "数据异常"
    if decided < 100 or boot_count < 10 or day_count < 3:
        return "样本不足"
    # Highest conclusion requires reliable profit coverage when ROI is used.
    profit_ok = profit_coverage is not None and profit_coverage >= 0.95
    weak = False
    if q_value is not None and q_value > 0.05:
        weak = True
    if wilson_lower is None or wilson_lower <= baseline:
        weak = True
    if walk_stability is None or walk_stability < 0.6:
        weak = True
    if weak:
        return "暂未发现稳定优势"
    if profit_ok and roi is not None and roi < 0:
        return "历史样本中表现偏弱"
    if wilson_lower is not None and wilson_lower < baseline:
        return "历史样本中表现偏弱"
    if (
        (q_value is not None and q_value <= 0.05)
        and wilson_lower is not None
        and wilson_lower > baseline
        and walk_stability is not None
        and walk_stability >= 0.6
        and (strict_ratio is None or strict_ratio >= 0.8)
        and (not profit_ok or (roi is not None and roi > 0))
        and (not profit_ok or bootstrap_roi_lo is None or bootstrap_roi_lo >= -0.05)
    ):
        return "历史样本中表现较稳"
    return "暂未发现稳定优势"
