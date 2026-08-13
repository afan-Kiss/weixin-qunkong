#!/usr/bin/env python3
"""
WXQK MeshCentral LIVE SESSION GATE CHECK.

Validates server Mesh config, control channel, node online/mapping, and that
Desktop/Files embed sessions can be created. Does NOT claim real Desktop
framebuffer or Files upload/download success.

Usage:
  python server/wxqk/mesh_live_e2e_check.py --client-id <clientId>

Exit codes:
  0 = READY_FOR_USER_LIVE_TEST
  2 = gate failed / not ready
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

try:
    from mesh_env_loader import load_mesh_env_files

    load_mesh_env_files()
except Exception:
    pass

import meshcentral_client as mc  # noqa: E402


def redact_id(value: str) -> str:
    text = str(value or "")
    if len(text) <= 8:
        return "***" if text else "-"
    return f"{text[:4]}***{text[-4:]}"


def _line(name: str, ok: bool, detail: str = "") -> None:
    status = "PASS" if ok else "FAIL"
    extra = f" {detail}" if detail else ""
    print(f"{name}: {status}{extra}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Mesh live session gate check")
    parser.add_argument("--client-id", required=True)
    parser.add_argument("--hostname", default="")
    parser.add_argument("--data-dir", default=os.environ.get("WXQK_DATA_DIR") or str(ROOT / "_e2e_data"))
    args = parser.parse_args()

    if not mc.is_enabled():
        _line("SERVER", False, "WXQK_MESH_ENABLED not true")
        print("RESULT: NOT_READY")
        return 3
    if not mc.public_url():
        _line("SERVER", False, "WXQK_MESH_URL missing")
        print("RESULT: NOT_READY")
        return 3
    try:
        mc._login_key_bytes()
    except Exception as exc:
        _line("SERVER", False, f"login key unavailable ({exc})")
        print("RESULT: NOT_READY")
        return 3
    _line("SERVER", True)

    data_dir = Path(args.data_dir)
    data_dir.mkdir(parents=True, exist_ok=True)
    cid = str(args.client_id).strip()
    print(f"target client={redact_id(cid)} hostname={args.hostname or '-'}")

    control_ok = False
    try:
        synced = mc.sync_nodes_via_control(timeout=8)
        control_ok = bool(synced.get("ok"))
        _line("CONTROL", control_ok, str(synced.get("code") or "")[:60])
    except Exception as exc:
        _line("CONTROL", False, str(exc)[:80])

    mc.clear_live_status_cache()
    status = mc.get_device_status(data_dir, cid, hostname=args.hostname)
    remote_state = str(status.get("remoteState") or "")
    node_id = str(status.get("meshNodeId") or "")
    node_found = bool(node_id) and remote_state not in ("unbound",)
    node_online = bool(status.get("online") and status.get("ready"))
    auto_bind_ok = remote_state in ("ready", "bound_offline", "preparing") or bool(status.get("bound"))

    _line("NODE_FOUND", node_found, f"node={redact_id(node_id)} state={remote_state}")
    _line("NODE_ONLINE", node_online, str(status.get("userMessage") or status.get("code") or "")[:80])
    _line("AUTO_BIND", auto_bind_ok and remote_state != "error", f"state={remote_state}")

    if not status.get("ready"):
        print("")
        print("RESULT: NOT_READY")
        print("NOTE: mapping-only is never treated as success")
        return 2

    desk = mc.get_remote_session(data_dir, cid, hostname=args.hostname)
    files = mc.get_files_session(data_dir, cid, hostname=args.hostname)
    desk_ok = bool(desk.get("ok")) and int(desk.get("viewmode") or 0) == 11
    files_ok = bool(files.get("ok")) and int(files.get("viewmode") or 0) == 13
    desk_url = str(desk.get("embedUrl") or "")
    files_url = str(files.get("embedUrl") or "")

    _line("DESKTOP_SESSION", desk_ok)
    if desk_ok:
        print("VIEWMODE: 11")
        print(f"HIDE63: {'yes' if 'hide=63' in desk_url else 'no'}")
    _line("FILES_SESSION", files_ok)
    if files_ok:
        print("VIEWMODE: 13")
        print(f"HIDE63: {'yes' if 'hide=63' in files_url else 'no'}")

    # Never print tokens / full node / login key
    blob = json.dumps({"desk": desk, "files": files, "status": status}, ensure_ascii=False)
    login_fp_safe = True
    try:
        key = os.environ.get("WXQK_MESH_LOGIN_KEY") or ""
        if key and key in blob:
            login_fp_safe = False
    except Exception:
        pass
    if not login_fp_safe:
        print("SECURITY: FAIL login key appeared in gate output payload")
        print("RESULT: NOT_READY")
        return 2

    print("")
    if control_ok and node_found and node_online and desk_ok and files_ok:
        print("RESULT: READY_FOR_USER_LIVE_TEST")
        print("NOTE: User must verify real Desktop picture/mouse and Files upload/download/SHA256/delete.")
        return 0
    print("RESULT: NOT_READY")
    return 2


if __name__ == "__main__":
    sys.exit(main())
