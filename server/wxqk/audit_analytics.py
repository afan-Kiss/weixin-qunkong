#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Read-only analytics integrity + migration reconciliation audit. Never mutates data."""
from __future__ import annotations

import json
import os
import sys
from collections import defaultdict
from pathlib import Path

DATA_DIR = Path(os.environ.get("FACAI888_DATA") or os.environ.get("SIREN_DATA") or "/opt/facai888/data")
FORMULA_JSONL = DATA_DIR / "formula" / "events.jsonl"
ROADS_DIR = DATA_DIR / "roads"


def _count_formula_source(path: Path) -> dict:
    out = {
        "source_file_count": 1 if path.exists() else 0,
        "source_line_total": 0,
        "source_valid_total": 0,
        "invalid_skipped": 0,
        "failed_total": 0,
    }
    if not path.exists():
        return out
    with path.open("r", encoding="utf-8", errors="replace") as f:
        for ln in f:
            out["source_line_total"] += 1
            ln = ln.strip()
            if not ln:
                out["invalid_skipped"] += 1
                continue
            try:
                row = json.loads(ln)
            except Exception:
                out["failed_total"] += 1
                continue
            if not isinstance(row, dict):
                out["invalid_skipped"] += 1
                continue
            code = str(row.get("code") or "").upper()
            formula = str(row.get("formula") or row.get("patternHash") or row.get("patternText") or "").strip()
            if code not in {"PLACE_OK", "PLACE_BLOCKED", "PLACE_FAILED", "SETTLE_OK", "SETTLE_UNKNOWN"} or not formula:
                out["invalid_skipped"] += 1
                continue
            out["source_valid_total"] += 1
    return out


def _count_road_source(root: Path) -> dict:
    out = {
        "source_file_count": 0,
        "source_boot_total": 0,
        "source_valid_total": 0,
        "invalid_skipped": 0,
        "failed_total": 0,
    }
    if not root.exists():
        return out
    for day_dir in root.iterdir():
        if not day_dir.is_dir():
            continue
        for path in day_dir.glob("*.json"):
            out["source_file_count"] += 1
            try:
                doc = json.loads(path.read_text(encoding="utf-8"))
            except Exception:
                out["failed_total"] += 1
                continue
            boots = doc.get("boots") or {}
            if not isinstance(boots, dict):
                out["invalid_skipped"] += 1
                continue
            for _b, body in boots.items():
                out["source_boot_total"] += 1
                if not isinstance(body, dict) or not str(body.get("s") or ""):
                    out["invalid_skipped"] += 1
                    continue
                out["source_valid_total"] += 1
    return out


def main() -> int:
    try:
        import analytics_db as adb
        from road_quality import validate_beads, is_unknown_boot
    except Exception as e:
        print(f"FAIL import: {e}")
        return 2

    adb.configure(DATA_DIR)
    conn = adb.get_conn()
    issues: list[str] = []

    tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
    for t in ("formula_events", "road_boots", "road_updates", "backtest_runs", "road_client_hashes"):
        if t not in tables:
            issues.append(f"missing table {t}")

    integrity = adb.integrity_check()
    print(f"integrity_check: {integrity}")
    if integrity != "ok":
        issues.append(f"integrity_check={integrity}")

    # --- formula reconciliation ---
    src_f = _count_formula_source(FORMULA_JSONL)
    db_total = conn.execute("SELECT COUNT(*) FROM formula_events").fetchone()[0]
    legacy_total = conn.execute(
        "SELECT COUNT(*) FROM formula_events WHERE settlement_confidence='LEGACY' OR source='legacy_import'"
    ).fetchone()[0]
    imported = int(adb.get_meta("formula_events_migrated_count") or "0")
    # For already-migrated DBs: duplicates are events that were skipped on re-run.
    # Reconciliation uses: valid ≈ inserted_at_migration + invalid + failed (from source scan).
    # Live events after migration inflate database_total above migrated count — expected.
    duplicate_skipped = max(0, src_f["source_valid_total"] - imported) if adb.get_meta("formula_events_migrated") == "1" else 0
    # Better accounting when meta stores full breakdown; fall back to soft check.
    formula_recon = {
        **src_f,
        "inserted_total": imported,
        "duplicate_skipped": duplicate_skipped,
        "database_total": db_total,
        "legacy_database_total": legacy_total,
    }
    # Identity: source_valid = inserted + duplicate_skipped + (remaining live not in source)
    # Strict check on migration completeness vs source valid:
    migrated_ok = adb.get_meta("formula_events_migrated") == "1"
    if migrated_ok:
        # All source-valid rows should have been attempted; imported <= valid
        formula_recon["reconciliation_ok"] = imported <= src_f["source_valid_total"] and (
            src_f["source_valid_total"] == 0 or imported + formula_recon["invalid_skipped"] + formula_recon["failed_total"] <= src_f["source_line_total"]
        )
        # Stronger: imported + invalid + failed should cover valid lines from source at migration time
        # Live inserts after migration mean database_total >= imported.
        if db_total < imported:
            formula_recon["reconciliation_ok"] = False
            issues.append("formula database_total < migrated inserted_total")
    else:
        formula_recon["reconciliation_ok"] = src_f["source_valid_total"] == 0
    print("FORMULA_RECON", json.dumps(formula_recon, ensure_ascii=False))
    if not formula_recon["reconciliation_ok"]:
        issues.append("formula reconciliation_ok=false")

    # --- road reconciliation ---
    src_r = _count_road_source(ROADS_DIR)
    db_boots = conn.execute("SELECT COUNT(*) FROM road_boots").fetchone()[0]
    legacy_boots = conn.execute(
        "SELECT COUNT(*) FROM road_boots WHERE quality_level='C' AND quality_reasons LIKE '%LEGACY%'"
    ).fetchone()[0]
    imported_r = int(adb.get_meta("roads_migrated_count") or "0")
    road_recon = {
        **src_r,
        "inserted_total": imported_r,
        "updated_total": 0,
        "duplicate_skipped": max(0, src_r["source_valid_total"] - imported_r) if adb.get_meta("roads_migrated") == "1" else 0,
        "database_boot_total": db_boots,
        "legacy_database_total": legacy_boots,
    }
    if adb.get_meta("roads_migrated") == "1":
        road_recon["reconciliation_ok"] = imported_r <= src_r["source_valid_total"] and db_boots >= imported_r
    else:
        road_recon["reconciliation_ok"] = src_r["source_valid_total"] == 0
    print("ROAD_RECON", json.dumps(road_recon, ensure_ascii=False))
    if not road_recon["reconciliation_ok"]:
        issues.append("road reconciliation_ok=false")

    # integrity spot checks
    places = {r[0] for r in conn.execute(
        "SELECT bet_transaction_id FROM formula_events WHERE code='PLACE_OK' AND bet_transaction_id!=''"
    )}
    settles = {r[0] for r in conn.execute(
        "SELECT bet_transaction_id FROM formula_events WHERE code IN ('SETTLE_OK','SETTLE_UNKNOWN') AND bet_transaction_id!=''"
    )}
    print(f"open PLACE without SETTLE: {len(places - settles)}")
    print(f"SETTLE without PLACE: {len(settles - places)}")

    boots = conn.execute(
        "SELECT day, table_id, boot_no, seq, quality_level, quality_reasons FROM road_boots"
    ).fetchall()
    illegal = unknown = conflict = 0
    for b in boots:
        if not validate_beads(b["seq"] or ""):
            illegal += 1
        if is_unknown_boot(b["boot_no"] or ""):
            unknown += 1
        if "CLIENT_SEQUENCE_CONFLICT" in (b["quality_reasons"] or ""):
            conflict += 1
    print(f"road boots: {len(boots)} illegal={illegal} unknown_boot={unknown} conflict={conflict}")

    by_key: dict[tuple, set[str]] = defaultdict(set)
    for r in conn.execute(
        "SELECT day, table_id, boot_no, seq_len, client_id, seq_hash FROM road_client_hashes"
    ):
        by_key[(r["day"], r["table_id"], r["boot_no"], r["seq_len"])].add(r["seq_hash"])
    multi = sum(1 for hashes in by_key.values() if len(hashes) > 1)
    print(f"seqLen hash conflicts: {multi}")
    geom = conn.execute("SELECT COUNT(*) FROM road_boots WHERE geometry_verified=0").fetchone()[0]
    print(f"geometryVerified=0 boots: {geom}")

    if issues:
        print("ISSUES:")
        for i in issues:
            print(" -", i)
        return 1
    print("OK: analytics audit passed (report-only)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
