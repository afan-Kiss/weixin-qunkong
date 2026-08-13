#!/usr/bin/env python3
"""
Browser-level MeshCentral embed relay gate for WXQK.

Validates Desktop/Files reach MeshCentral "Connected" status after wxqkauto.
Does NOT claim real framebuffer / file IO success (user GUI gate).

Requires: playwright (pip install playwright && playwright install chromium)

Usage on Mesh/wxqk host:
  python3 mesh_embed_e2e_check.py --client-id <clientId>
"""
from __future__ import annotations

import argparse
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


def redact(value: str) -> str:
    text = str(value or "")
    if len(text) <= 8:
        return "***" if text else "-"
    return f"{text[:4]}***{text[-4:]}"


def _line(name: str, ok: bool, detail: str = "") -> None:
    print(f"{name}: {'PASS' if ok else 'FAIL'}{(' ' + detail) if detail else ''}")


def wait_relay_connected(page, *, status_id: str, timeout_ms: int = 90000) -> tuple[bool, str]:
    """Poll MeshCentral status element until Connected (or timeout)."""
    deadline_js = (
        f"() => {{"
        f"  const el = document.getElementById('{status_id}');"
        f"  const t = el ? (el.textContent || el.innerText || '') : '';"
        f"  return t;"
        f"}}"
    )
    import time

    end = time.time() + (timeout_ms / 1000.0)
    last = ""
    while time.time() < end:
        try:
            last = str(page.evaluate(deadline_js) or "")
        except Exception as exc:
            last = f"eval_error:{type(exc).__name__}"
        if "Connected" in last and "Disconnected" not in last:
            return True, last.strip()[:80]
        page.wait_for_timeout(500)
    return False, last.strip()[:80]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--client-id", required=True)
    parser.add_argument("--hostname", default="")
    parser.add_argument("--data-dir", default=os.environ.get("WXQK_DATA_DIR") or str(ROOT / "_e2e_data"))
    parser.add_argument("--hide-diag", action="store_true", help="Use hide=0 for diagnosis (default hide=63)")
    args = parser.parse_args()

    try:
        from playwright.sync_api import sync_playwright
    except Exception:
        _line("PLAYWRIGHT", False, "not installed")
        print("RESULT: NOT_READY")
        print("NOTE: pip install playwright && playwright install chromium")
        return 3

    if not mc.is_enabled():
        _line("SERVER", False, "mesh disabled")
        print("RESULT: NOT_READY")
        return 3

    data_dir = Path(args.data_dir)
    data_dir.mkdir(parents=True, exist_ok=True)
    cid = str(args.client_id).strip()
    print(f"target client={redact(cid)}")

    desk = mc.get_remote_session(data_dir, cid, hostname=args.hostname)
    files = mc.get_files_session(data_dir, cid, hostname=args.hostname)
    desk_url = str(desk.get("embedUrl") or "")
    files_url = str(files.get("embedUrl") or "")
    # Browser on the Mesh host cannot hairpin to the public IP for control WS.
    # Rewrite embed host to loopback for local relay verification only.
    local_host = str(os.environ.get("WXQK_MESH_WS_LOCAL_HOST") or "127.0.0.1").strip() or "127.0.0.1"
    try:
        from urllib.parse import urlparse, urlunparse

        def _to_local(u: str) -> str:
            p = urlparse(u)
            if not p.scheme:
                return u
            netloc = p.netloc
            if "@" in netloc:
                return u
            hostport = netloc
            if hostport.startswith("["):
                return u
            if ":" in hostport:
                host, port = hostport.rsplit(":", 1)
                netloc2 = f"{local_host}:{port}"
            else:
                netloc2 = local_host
            return urlunparse((p.scheme, netloc2, p.path, p.params, p.query, p.fragment))

        desk_url = _to_local(desk_url)
        files_url = _to_local(files_url)
    except Exception:
        pass
    desk_sess = bool(desk.get("ok")) and "viewmode=11" in desk_url and "wxqkauto=desktop" in desk_url
    files_sess = bool(files.get("ok")) and "viewmode=13" in files_url and "wxqkauto=files" in files_url
    _line("DESKTOP_SESSION_GATE", desk_sess)
    _line("FILES_SESSION_GATE", files_sess)
    if not desk_sess or not files_sess:
        print("RESULT: NOT_READY")
        return 2

    if args.hide_diag:
        desk_url = desk_url.replace("hide=63", "hide=0")
        files_url = files_url.replace("hide=63", "hide=0")

    desk_relay = False
    files_relay = False
    desk_detail = ""
    files_detail = ""

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(ignore_https_errors=True)
        try:
            page = context.new_page()
            page.goto(desk_url, wait_until="domcontentloaded", timeout=60000)
            desk_relay, desk_detail = wait_relay_connected(page, status_id="deskstatus")
            _line("DESKTOP_RELAY_GATE", desk_relay, desk_detail)

            page2 = context.new_page()
            page2.goto(files_url, wait_until="domcontentloaded", timeout=60000)
            files_relay, files_detail = wait_relay_connected(page2, status_id="p13Status")
            _line("FILES_RELAY_GATE", files_relay, files_detail)
        finally:
            browser.close()

    # Never print tokens
    blob = desk_url + files_url + desk_detail + files_detail
    key = os.environ.get("WXQK_MESH_LOGIN_KEY") or ""
    if key and key in blob:
        print("SECURITY: FAIL login key appeared in output")
        print("RESULT: NOT_READY")
        return 2

    print("")
    if desk_sess and files_sess and desk_relay and files_relay:
        print("RESULT: READY_FOR_USER_GUI_TEST")
        print("NOTE: User must verify real Desktop picture/mouse and Files upload/download/SHA256/delete.")
        return 0
    print("RESULT: NOT_READY")
    return 2


if __name__ == "__main__":
    sys.exit(main())
