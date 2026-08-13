#!/usr/bin/env python3
"""
WXQK MeshCentral live readiness / session gate diagnostic.

Does NOT claim Desktop framebuffer or Files upload success by itself.
Requires env credentials to talk to wxqk + MeshCentral.

Usage (PowerShell example):
  $env:WXQK_MESH_ENABLED='1'
  $env:WXQK_MESH_URL='https://120.27.219.138:8444'
  $env:WXQK_MESH_LOGIN_KEY='<hex>'
  $env:WXQK_MESH_USER='user//admin'
  $env:WXQK_DATA_DIR='D:\\wxqk-data'   # optional; default ./_e2e_data
  python server/wxqk/mesh_live_e2e_check.py --client-id <clientId>

Exit codes:
  0 = mapping live-ready + desktop/files embed URLs minted
  2 = blocked / not ready
  3 = misconfigured
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import meshcentral_client as mc  # noqa: E402


def redact_id(value: str) -> str:
    text = str(value or "")
    if len(text) <= 8:
        return "***" if text else ""
    return f"{text[:4]}…{text[-4:]}"


def main() -> int:
    parser = argparse.ArgumentParser(description="Mesh live status + session gate check")
    parser.add_argument("--client-id", required=True)
    parser.add_argument("--hostname", default="")
    parser.add_argument("--data-dir", default=os.environ.get("WXQK_DATA_DIR") or str(ROOT / "_e2e_data"))
    args = parser.parse_args()

    if not mc.is_enabled():
        print("BLOCKED: WXQK_MESH_ENABLED is not true")
        return 3
    if not mc.public_url():
        print("BLOCKED: WXQK_MESH_URL missing")
        return 3
    try:
        mc._login_key_bytes()
    except Exception as exc:
        print(f"BLOCKED: login key unavailable ({exc})")
        return 3

    data_dir = Path(args.data_dir)
    data_dir.mkdir(parents=True, exist_ok=True)
    cid = str(args.client_id).strip()
    print(f"clientId={redact_id(cid)} hostname={args.hostname or '-'}")

    mc.clear_live_status_cache()
    status = mc.get_device_status(data_dir, cid, hostname=args.hostname)
    print("status:", json.dumps({
        "code": status.get("code"),
        "remoteState": status.get("remoteState"),
        "bound": status.get("bound"),
        "online": status.get("online"),
        "ready": status.get("ready"),
        "verified": status.get("verified"),
        "userMessage": status.get("userMessage"),
        "meshNodeId": redact_id(str(status.get("meshNodeId") or "")),
    }, ensure_ascii=False))

    if not status.get("ready"):
        print("RESULT: NOT_READY (refusing to treat mapping-only as success)")
        return 2

    desk = mc.get_remote_session(data_dir, cid, hostname=args.hostname)
    files = mc.get_files_session(data_dir, cid, hostname=args.hostname)
    print("desktop:", {
        "ok": desk.get("ok"),
        "viewmode": desk.get("viewmode"),
        "hasEmbedUrl": bool(desk.get("embedUrl")),
        "hide63": "hide=63" in str(desk.get("embedUrl") or ""),
        "vm11": "viewmode=11" in str(desk.get("embedUrl") or ""),
    })
    print("files:", {
        "ok": files.get("ok"),
        "viewmode": files.get("viewmode"),
        "hasEmbedUrl": bool(files.get("embedUrl")),
        "hide63": "hide=63" in str(files.get("embedUrl") or ""),
        "vm13": "viewmode=13" in str(files.get("embedUrl") or ""),
    })

    if desk.get("ok") and files.get("ok"):
        print("RESULT: SESSION_GATE_PASS")
        print("NOTE: Still must verify Desktop framebuffer + Files upload/download/SHA256 in admin UI.")
        return 0
    print("RESULT: SESSION_GATE_FAIL")
    return 2


if __name__ == "__main__":
    sys.exit(main())
