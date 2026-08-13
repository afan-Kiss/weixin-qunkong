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
        # EN Connected / ZH 已连接
        if "Disconnected" in last or "已断开" in last:
            pass
        elif ("Connected" in last) or ("已连接" in last):
            return True, last.strip()[:80]
        page.wait_for_timeout(500)
    return False, last.strip()[:80]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--client-id", required=True)
    parser.add_argument("--hostname", default="")
    parser.add_argument("--data-dir", default=os.environ.get("WXQK_DATA_DIR") or str(ROOT / "_e2e_data"))
    parser.add_argument("--hide-diag", action="store_true", help="Use hide=0 for diagnosis (default hide=63)")
    parser.add_argument(
        "--locale",
        default=os.environ.get("WXQK_MESH_E2E_LOCALE") or "zh-CN",
        help="Browser locale / Accept-Language (default zh-CN; Mesh serves translated views)",
    )
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
    # Keep public host in the embed URL so browser Origin stays valid.
    # MeshCentral rejects Origin https://127.0.0.1:… ("Invalid origin").
    # On the Mesh host, optional WXQK_MESH_WS_LOCAL_HOST maps DNS→loopback via Chromium.
    local_host = str(os.environ.get("WXQK_MESH_WS_LOCAL_HOST") or "").strip()
    chromium_args: list[str] = []
    if local_host:
        try:
            from urllib.parse import urlparse

            host = urlparse(desk_url).hostname or urlparse(files_url).hostname or ""
            if host and host not in ("127.0.0.1", "localhost"):
                chromium_args.append(f"--host-resolver-rules=MAP {host} {local_host}")
                print(f"hairpin MAP {host} -> {local_host}")
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

    locale = str(args.locale or "zh-CN").strip() or "zh-CN"
    print(f"browser locale={locale}")
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=chromium_args)
        context = browser.new_context(
            ignore_https_errors=True,
            locale=locale,
            extra_http_headers={"Accept-Language": f"{locale},{locale.split('-')[0]};q=0.9,en;q=0.5"},
        )
        try:
            page = context.new_page()
            page.goto(desk_url, wait_until="domcontentloaded", timeout=60000)
            try:
                p0 = str(page.evaluate("() => (document.querySelector('#p0span')||{}).textContent||''") or "")
            except Exception:
                p0 = ""
            if "无法执行身份验证" in p0 or "Unable to authenticate" in p0 or "Invalid origin" in p0 or "无效来源" in p0:
                _line("DESKTOP_RELAY_GATE", False, f"auth_or_origin:{p0[:60]}")
                desk_relay, desk_detail = False, p0[:80]
            else:
                desk_relay, desk_detail = wait_relay_connected(page, status_id="deskstatus")
                _line("DESKTOP_RELAY_GATE", desk_relay, desk_detail)

            page2 = context.new_page()
            page2.goto(files_url, wait_until="domcontentloaded", timeout=60000)
            try:
                p0f = str(page2.evaluate("() => (document.querySelector('#p0span')||{}).textContent||''") or "")
            except Exception:
                p0f = ""
            if "无法执行身份验证" in p0f or "Unable to authenticate" in p0f or "Invalid origin" in p0f or "无效来源" in p0f:
                _line("FILES_RELAY_GATE", False, f"auth_or_origin:{p0f[:60]}")
                files_relay, files_detail = False, p0f[:80]
            else:
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
