# -*- coding: utf-8 -*-
"""Idempotent migrate SIREN_DATA -> FACAI888_DATA (copy + marker; keep backup)."""
from __future__ import annotations

import json
import os
import shutil
import time
from pathlib import Path


def main() -> None:
    old = Path(os.environ.get("SIREN_DATA") or "/opt/betclient-siren/data")
    new = Path(os.environ.get("FACAI888_DATA") or "/opt/facai888/data")
    marker = new / ".migrated_from_siren.json"
    report = {"ok": True, "old": str(old), "new": str(new), "copied": [], "skipped": [], "errors": []}
    new.mkdir(parents=True, exist_ok=True)
    if marker.exists():
        print(json.dumps({"ok": True, "alreadyMigrated": True, **json.loads(marker.read_text(encoding="utf-8"))}, ensure_ascii=False))
        return
    if not old.exists():
        report["skipped"].append("old_missing")
    else:
        for root, dirs, files in os.walk(old):
            rel = Path(root).relative_to(old)
            # Skip screenshot caches
            if "shots" in rel.parts:
                report["skipped"].append(str(rel))
                dirs[:] = []
                continue
            dest_root = new / rel
            dest_root.mkdir(parents=True, exist_ok=True)
            for name in files:
                src = Path(root) / name
                dst = dest_root / name
                if dst.exists():
                    report["skipped"].append(str(dst))
                    continue
                try:
                    shutil.copy2(src, dst)
                    report["copied"].append(str(dst.relative_to(new)))
                except Exception as e:  # noqa: BLE001
                    report["errors"].append({"path": str(src), "error": str(e)})
                    report["ok"] = False
    report["finishedAt"] = time.time()
    marker.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False))


if __name__ == "__main__":
    main()
