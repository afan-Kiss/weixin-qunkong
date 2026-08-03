# -*- coding: utf-8 -*-
"""Strict physical big-road engine from chronological B/P/T sequences.

Mirrors classic baccarat big-road placement:
- Ties (T) do not create new banker/player cells
- Same side prefers downward; row 6 triggers rightward dragon tail
- Opposite side starts a new base column at row 0
- Occupied cells force rightward collision shift
"""
from __future__ import annotations

import hashlib
from typing import Any

from analytics_versions import BIG_ROAD_ALGORITHM_VERSION

ROWS = 6
SIDE_CN = {"B": "庄", "P": "闲"}
SIDE_EN = {"庄": "B", "闲": "P"}


def normalize_seq(seq: str) -> str:
    out = []
    for ch in str(seq or ""):
        u = ch.upper()
        if u in ("B", "P", "T"):
            out.append(u)
        elif ch in ("庄",):
            out.append("B")
        elif ch in ("闲",):
            out.append("P")
        elif ch in ("和",):
            out.append("T")
    return "".join(out)


def generate_big_road_from_chronological_seq(seq: str, *, rows: int = ROWS) -> dict[str, Any]:
    """Generate physical + logical big-road from chronological B/P/T."""
    grid_rows = max(1, int(rows or ROWS))
    s = normalize_seq(seq)
    occupied: dict[tuple[int, int], dict[str, Any]] = {}
    last: dict[str, Any] | None = None
    next_base = 0
    unsupported = False
    source_index = -1

    for ch in s:
        source_index += 1
        if ch == "T":
            if last is not None:
                last["tieNum"] = int(last.get("tieNum") or 0) + 1
            continue
        side = SIDE_CN[ch]
        if last is None:
            col, row = 0, 0
            next_base = 1
        elif last["side"] == side:
            col, row = last["columnIndex"], last["rowIndex"] + 1
            if row >= grid_rows or (col, row) in occupied:
                col, row = last["columnIndex"] + 1, last["rowIndex"]
                while (col, row) in occupied:
                    col += 1
                    unsupported = unsupported  # collision shift is supported
        else:
            col, row = next_base, 0
            while (col, row) in occupied:
                col += 1
                unsupported = True
            next_base = col + 1

        cell = {
            "columnIndex": col,
            "rowIndex": row,
            "side": side,
            "sourceIndex": source_index,
            "tieNum": 0,
        }
        occupied[(col, row)] = cell
        last = cell

    parsed = list(occupied.values())
    parsed.sort(key=lambda c: (c["columnIndex"], c["rowIndex"]))
    physical = _build_physical(parsed, grid_rows)
    logical_pack = _build_logical(physical, grid_rows)
    logical = logical_pack["logicalColumns"]
    tip_unreliable = logical_pack["tipUnreliable"] or unsupported
    absolute_latest = parsed[-1] if parsed else None
    rightmost = logical[-1] if logical else None
    latest_in_logical = rightmost["cells"][-1] if rightmost and rightmost["cells"] else None
    if absolute_latest and latest_in_logical:
        if (
            absolute_latest["columnIndex"] != latest_in_logical["columnIndex"]
            or absolute_latest["rowIndex"] != latest_in_logical["rowIndex"]
            or absolute_latest["side"] != latest_in_logical["side"]
        ):
            tip_unreliable = True

    struct = _structural_hash(physical, logical)
    return {
        "ok": bool(logical),
        "algorithmVersion": BIG_ROAD_ALGORITHM_VERSION,
        "rows": grid_rows,
        "cells": parsed,
        "physicalColumns": physical,
        "columns": logical,
        "latestCell": latest_in_logical,
        "absoluteLatestCell": absolute_latest,
        "rightmostColumnIndex": rightmost["columnIndex"] if rightmost else None,
        "rightmostSpanEnd": rightmost.get("spanEnd") if rightmost else None,
        "unsupportedShape": tip_unreliable or not logical,
        "structureHash": struct,
        "beadLen": len(s),
        "decidedLen": sum(1 for c in s if c in ("B", "P")),
    }


def _build_physical(parsed: list[dict[str, Any]], grid_rows: int) -> list[dict[str, Any]]:
    by_col: dict[int, list[dict[str, Any]]] = {}
    for c in parsed:
        by_col.setdefault(int(c["columnIndex"]), []).append(c)
    out = []
    for col in sorted(by_col):
        cells = sorted(by_col[col], key=lambda x: x["rowIndex"])
        out.append(_classify_physical(col, cells, grid_rows))
    return out


def _classify_physical(column_index: int, cells: list[dict[str, Any]], grid_rows: int) -> dict[str, Any]:
    if not cells:
        return {"columnIndex": column_index, "status": "empty", "side": "", "length": 0, "cells": []}
    if not any(c["rowIndex"] == 0 for c in cells):
        return {
            "columnIndex": column_index,
            "status": "dragon_tail",
            "side": cells[0]["side"],
            "length": len(cells),
            "cells": cells,
        }
    side = cells[0]["side"]
    if not all(c["side"] == side for c in cells):
        return {
            "columnIndex": column_index,
            "status": "mixed_side",
            "side": "",
            "length": len(cells),
            "cells": cells,
        }
    for i, c in enumerate(cells):
        if c["rowIndex"] != i:
            return {
                "columnIndex": column_index,
                "status": "non_contiguous",
                "side": side,
                "length": len(cells),
                "cells": cells,
            }
    return {
        "columnIndex": column_index,
        "status": "normal",
        "side": side,
        "length": len(cells),
        "cells": cells,
        "spanEnd": column_index,
    }


def _build_logical(physical: list[dict[str, Any]], grid_rows: int) -> dict[str, Any]:
    logical: list[dict[str, Any]] = []
    tip_unreliable = False
    for phys in physical:
        if phys["status"] == "empty":
            continue
        if phys["status"] == "normal":
            logical.append({
                "columnIndex": phys["columnIndex"],
                "spanEnd": phys["columnIndex"],
                "side": phys["side"],
                "length": phys["length"],
                "cells": list(phys["cells"]),
            })
            tip_unreliable = False
            continue
        if phys["status"] == "dragon_tail":
            prev = logical[-1] if logical else None
            can = (
                not tip_unreliable
                and prev
                and prev["side"] == phys["side"]
                and prev["spanEnd"] + 1 == phys["columnIndex"]
                and any(c["rowIndex"] == grid_rows - 1 for c in prev["cells"])
                and all(c["side"] == phys["side"] and c["rowIndex"] == grid_rows - 1 for c in phys["cells"])
            )
            if can:
                prev["length"] += phys["length"]
                prev["spanEnd"] = phys["columnIndex"]
                prev["cells"].extend(phys["cells"])
                continue
            tip_unreliable = True
            continue
        tip_unreliable = True
    return {"logicalColumns": logical, "tipUnreliable": tip_unreliable}


def _structural_hash(physical: list[dict[str, Any]], logical: list[dict[str, Any]]) -> str:
    parts = []
    for p in physical:
        parts.append(f"P{p['columnIndex']}:{p['status']}:{p.get('side','')}:{p['length']}")
    for c in logical:
        parts.append(f"L{c['columnIndex']}-{c.get('spanEnd', c['columnIndex'])}:{c['side']}:{c['length']}")
    return hashlib.sha256("|".join(parts).encode("utf-8")).hexdigest()


def match_latest_columns(grid: dict[str, Any], pattern_columns: list[dict[str, Any]]) -> dict[str, Any]:
    """Port of client matchLatestBigRoadColumns (side+height, adjacency, tip exact)."""
    if not grid.get("ok") or grid.get("unsupportedShape"):
        return {"ok": True, "matched": False, "reason": "unsupported_shape"}
    cols = grid.get("columns") or []
    phys_list = grid.get("physicalColumns") or []
    if not pattern_columns or not cols or len(cols) < len(pattern_columns):
        return {"ok": True, "matched": False, "reason": "insufficient_columns"}

    physical = {int(p["columnIndex"]): p for p in phys_list}
    suffix = cols[-len(pattern_columns) :]

    def span_end(col: dict[str, Any]) -> int:
        return int(col.get("spanEnd", col["columnIndex"]))

    for i, col in enumerate(suffix):
        se = span_end(col)
        for idx in range(int(col["columnIndex"]), se + 1):
            phys = physical.get(idx)
            if not phys:
                return {"ok": True, "matched": False, "reason": "invalid_column_between_suffix"}
            if idx == col["columnIndex"] and phys["status"] != "normal":
                return {"ok": True, "matched": False, "reason": "invalid_column_between_suffix"}
            if idx > col["columnIndex"] and phys["status"] != "dragon_tail":
                return {"ok": True, "matched": False, "reason": "invalid_column_between_suffix"}
        if i > 0:
            prev = suffix[i - 1]
            if int(col["columnIndex"]) != span_end(prev) + 1:
                return {"ok": True, "matched": False, "reason": "non_adjacent_columns"}

    for i, expected in enumerate(pattern_columns):
        actual = suffix[i]
        if actual.get("side") != expected.get("side") or int(actual.get("length") or 0) != int(expected.get("length") or 0):
            return {"ok": True, "matched": False, "reason": "column_mismatch"}

    last = suffix[-1]
    tip = last["cells"][-1] if last.get("cells") else None
    latest = grid.get("latestCell")
    absolute = grid.get("absoluteLatestCell")
    if not tip or not latest:
        return {"ok": True, "matched": False, "reason": "not_latest_suffix"}
    if (
        latest["columnIndex"] != tip["columnIndex"]
        or latest["rowIndex"] != tip["rowIndex"]
        or latest["side"] != tip["side"]
    ):
        return {"ok": True, "matched": False, "reason": "not_latest_suffix"}
    if absolute and (
        absolute["columnIndex"] != tip["columnIndex"]
        or absolute["rowIndex"] != tip["rowIndex"]
        or absolute["side"] != tip["side"]
    ):
        return {"ok": True, "matched": False, "reason": "unsupported_right_edge"}

    tip_key = f"{last['columnIndex']}:{span_end(last)}:{last['side']}:{last['length']}:{tip['rowIndex']}"
    return {
        "ok": True,
        "matched": True,
        "reason": "latest_columns_exact_match",
        "roadTipKey": tip_key,
        "matchedColumns": suffix,
        "tipSide": tip["side"],
    }


def parse_pattern_columns(text: str) -> dict[str, Any]:
    """Parse 庄/闲 formula into columns {side,length} — same as client."""
    import re

    raw = str(text or "").strip()
    compact = re.sub(r"[\s,，、|/\n\r\t]+", "", raw)
    if not compact:
        return {"ok": False, "message": "公式不能为空", "columns": []}
    tokens: list[str] = []
    for ch in compact:
        if ch in ("庄", "B", "b"):
            tokens.append("庄")
        elif ch in ("闲", "P", "p"):
            tokens.append("闲")
        elif ch in ("和", "T", "t"):
            return {"ok": False, "message": "公式不能包含和", "columns": []}
        else:
            return {"ok": False, "message": f"非法字符:{ch}", "columns": []}
    if not tokens:
        return {"ok": False, "message": "公式不能为空", "columns": []}
    columns: list[dict[str, Any]] = []
    cur_side = tokens[0]
    length = 1
    for t in tokens[1:]:
        if t == cur_side:
            length += 1
        else:
            columns.append({"side": cur_side, "length": length})
            cur_side = t
            length = 1
    columns.append({"side": cur_side, "length": length})
    if len(tokens) < 2:
        return {"ok": False, "message": "公式至少需要 2 个结果", "columns": []}
    if len(tokens) > 24:
        return {"ok": False, "message": "公式最多 24 个结果", "columns": []}
    # Match client bigRoadPatternParser / road_archive.parse_pattern
    ph = "|".join(f"{c['side']}{c['length']}" for c in columns)
    normalized = "".join(tokens)
    return {"ok": True, "columns": columns, "normalized": normalized, "patternHash": ph}
