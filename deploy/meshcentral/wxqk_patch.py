#!/usr/bin/env python3
"""
Apply / verify WXQK MeshCentral 1.2.4 embed patches.

Patches (1.2.4 only, idempotent):
  1) AUTHCOOKIE — MeshServerCreateControl(domainUrl, authCookie)
     Official handlebars only passes domainUrl. Behind TlsOffload with
     sessionSameSite=none, browsers reject session cookies (SameSite=None
     without Secure). Without authCookie, control.ashx gets noauth → black
     embed. Passing authCookie enables ?moreargs=1 + urlargs auth (1.2.4 API).
  2) AUTOCONNECT — ?wxqkauto=desktop|files / framed viewmode 11|13
     Official viewmode only gotoDevice(); does not connectDesktop/Files.

IMPORTANT: MeshCentral serves locale-specific views under views/translations/
(e.g. default-min_zh-chs.handlebars). Chinese UI will NOT use English
default-min.handlebars — all matching views must be patched.

FAIL CLOSED unless MeshCentral version is exactly 1.2.4.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
from pathlib import Path

HERE = Path(__file__).resolve().parent
PINNED = "1.2.4"
SNIPPET_PATH = HERE / "patches" / "wxqk_autoconnect.snippet.js"
MARKER_BEGIN = "/* WXQK_AUTOCONNECT_V1_BEGIN */"
MARKER_END = "/* WXQK_AUTOCONNECT_V1_END */"
AUTH_MARKER = "/* WXQK_AUTHCOOKIE_V1 */"
# Only replace bare CreateControl(domainUrl) — not already-patched (domainUrl, authCookie).
AUTH_NEEDLE_RE = re.compile(r"MeshServerCreateControl\(\s*domainUrl\s*\)(?!\s*,)")
AUTH_DONE = "MeshServerCreateControl(domainUrl, authCookie)"
AUTH_REPLACEMENT = "MeshServerCreateControl(domainUrl, authCookie)/* WXQK_AUTHCOOKIE_V1 */"
AUTH_DONE_RE = re.compile(r"MeshServerCreateControl\(\s*domainUrl\s*,\s*authCookie\s*\)")
# Fallback list when discovery fails.
VIEWS_FALLBACK = (
    "default.handlebars",
    "default-min.handlebars",
    "translations/default_zh-chs.handlebars",
    "translations/default-min_zh-chs.handlebars",
    "translations/default_zh-cht.handlebars",
    "translations/default-min_zh-cht.handlebars",
)
CONTAINER = os.environ.get("WXQK_MESH_CONTAINER") or "wxqk-meshcentral"
REMOTE_VIEWS = "/opt/meshcentral/meshcentral/views"
PERSIST_DIR = HERE / "data" / "wxqk-views"
PACKAGE_JSON = "/opt/meshcentral/meshcentral/package.json"


def _run(cmd: list[str], *, check: bool = True, capture: bool = False) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        cmd,
        check=check,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=capture,
    )


def read_snippet() -> str:
    raw = SNIPPET_PATH.read_text(encoding="utf-8")
    if MARKER_BEGIN not in raw or MARKER_END not in raw:
        raise RuntimeError("snippet missing WXQK markers")
    if "connectDesktop(null, 3)" not in raw or "connectFiles(null, 1)" not in raw:
        raise RuntimeError("snippet missing required connect calls")
    return raw.strip() + "\n"


def meshcentral_version() -> str:
    proc = _run(
        ["docker", "exec", CONTAINER, "node", "-p", f"require('{PACKAGE_JSON}').version"],
        check=False,
        capture=True,
    )
    if proc.returncode != 0:
        return ""
    return (proc.stdout or "").strip()


def discover_views() -> list[str]:
    """Find default / default-min handlebars (all locales) that need the control patch.

    MeshCentral serves translations/default-min_zh-chs.handlebars for Chinese UI
    when minify=true — English default-min.handlebars is NOT used then.
    """
    proc = _run(
        [
            "docker",
            "exec",
            CONTAINER,
            "sh",
            "-lc",
            f"grep -rl 'MeshServerCreateControl' {REMOTE_VIEWS} --include='*.handlebars' 2>/dev/null | sort",
        ],
        check=False,
        capture=True,
    )
    views: list[str] = []
    prefix = REMOTE_VIEWS.rstrip("/") + "/"
    for line in (proc.stdout or "").splitlines():
        path = line.strip()
        if not path.startswith(prefix):
            continue
        rel = path[len(prefix) :]
        base = Path(rel).name
        # Desktop web UI only (skip xterm / default3 / mobile)
        if base == "default.handlebars" or base == "default-min.handlebars":
            views.append(rel)
            continue
        if base.startswith("default_") and base.endswith(".handlebars") and "mobile" not in base and "default3" not in base:
            views.append(rel)
            continue
        if base.startswith("default-min_") and base.endswith(".handlebars"):
            views.append(rel)
            continue
    if not views:
        return list(VIEWS_FALLBACK)
    return views


# Back-compat for older imports/tests
VIEWS = VIEWS_FALLBACK


def _docker_cp(src: str, dst: str) -> None:
    _run(["docker", "cp", src, dst], check=True)


def _extract_view(name: str, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    _docker_cp(f"{CONTAINER}:{REMOTE_VIEWS}/{name}", str(dest))


def _inject_authcookie(text: str) -> tuple[str, str]:
    """Ensure MeshServerCreateControl receives authCookie (1.2.4 signature)."""
    if AUTH_MARKER in text and AUTH_DONE_RE.search(text):
        return text, "unchanged"
    if AUTH_DONE_RE.search(text) and not AUTH_NEEDLE_RE.search(text):
        # Already has authCookie arg but missing our marker
        new, n = AUTH_DONE_RE.subn(AUTH_REPLACEMENT, text, count=1)
        return new, "marked" if n else "unchanged"
    if not AUTH_NEEDLE_RE.search(text):
        raise RuntimeError("view missing bare MeshServerCreateControl(domainUrl)")
    new, n = AUTH_NEEDLE_RE.subn(AUTH_REPLACEMENT, text, count=1)
    if n != 1:
        raise RuntimeError("authcookie patch replace failed")
    return new, "patched"


def _inject_autoconnect(text: str, snippet: str) -> tuple[str, str]:
    """Return (new_text, action) where action is inserted|replaced|unchanged."""
    snip = snippet.strip() + "\n"
    if MARKER_BEGIN in text and MARKER_END in text:
        start = text.index(MARKER_BEGIN)
        end = text.index(MARKER_END) + len(MARKER_END)
        while end < len(text) and text[end] in "\r\n":
            end += 1
        existing = text[start:end].strip() + "\n"
        if existing == snip:
            return text, "unchanged"
        new = text[:start] + snip + text[end:]
        return new, "replaced"
    body_idx = text.lower().rfind("</body>")
    search_to = body_idx if body_idx >= 0 else len(text)
    script_idx = text.rfind("</script>", 0, search_to)
    if script_idx < 0:
        script_idx = text.lower().rfind("</script>")
    if script_idx < 0:
        # minified zh files sometimes end without a trailing script close we can find;
        # append before </html> or at end.
        html_idx = text.lower().rfind("</html>")
        if html_idx >= 0:
            return text[:html_idx] + "\n<script>\n" + snip + "</script>\n" + text[html_idx:], "inserted"
        return text + "\n<script>\n" + snip + "</script>\n", "inserted"
    injection = "\n" + snip + "\n"
    new = text[:script_idx] + injection + text[script_idx:]
    return new, "inserted"


def _inject(text: str, snippet: str) -> tuple[str, str]:
    return _inject_autoconnect(text, snippet)


def apply_autoconnect_patch(*, restart: bool = True) -> dict:
    """Apply AUTHCOOKIE + AUTOCONNECT patches; restart MeshCentral by default."""
    ver = meshcentral_version()
    if ver != PINNED:
        return {
            "ok": False,
            "code": "VERSION_MISMATCH",
            "message": f"MeshCentral {ver or 'unknown'} != {PINNED}; refusing patch",
            "version": ver,
        }
    snippet = read_snippet()
    PERSIST_DIR.mkdir(parents=True, exist_ok=True)
    views = discover_views()
    results: dict[str, dict[str, str]] = {}
    errors: dict[str, str] = {}
    for name in views:
        local = PERSIST_DIR / name
        try:
            _extract_view(name, local)
            original = local.read_text(encoding="utf-8", errors="replace")
            patched, auth_action = _inject_authcookie(original)
            patched, auto_action = _inject_autoconnect(patched, snippet)
            local.write_text(patched, encoding="utf-8")
            # Ensure remote translations dir exists
            remote_parent = str(Path(REMOTE_VIEWS) / Path(name).parent).replace("\\", "/")
            _run(["docker", "exec", CONTAINER, "mkdir", "-p", remote_parent], check=False)
            _docker_cp(str(local), f"{CONTAINER}:{REMOTE_VIEWS}/{name}")
            results[name] = {"authcookie": auth_action, "autoconnect": auto_action}
        except Exception as exc:
            errors[name] = f"{type(exc).__name__}: {exc}"
    if restart:
        _run(["docker", "restart", CONTAINER], check=False)
    # Require at least English + zh-chs desktop views when present
    required_ok = True
    for req in (
        "default.handlebars",
        "default-min.handlebars",
        "translations/default-min_zh-chs.handlebars",
        "translations/default_zh-chs.handlebars",
    ):
        if req in views and req not in results:
            required_ok = False
    ok = required_ok and not errors
    return {
        "ok": ok,
        "code": "OK" if ok else "PATCH_PARTIAL",
        "version": ver,
        "views": results,
        "errors": errors,
        "discovered": views,
        "snippet_sha256": hashlib.sha256(snippet.encode("utf-8")).hexdigest()[:16],
    }


def verify_autoconnect_patch() -> dict:
    ver = meshcentral_version()
    if ver != PINNED:
        return {"ok": False, "code": "VERSION_MISMATCH", "version": ver, "views": {}}
    views = discover_views()
    checked: dict[str, dict[str, bool]] = {}
    for name in views:
        auto = _run(
            ["docker", "exec", CONTAINER, "sh", "-lc", f"grep -F '{MARKER_BEGIN}' {REMOTE_VIEWS}/{name}"],
            check=False,
            capture=True,
        )
        auth = _run(
            [
                "docker",
                "exec",
                CONTAINER,
                "sh",
                "-lc",
                f"grep -E 'MeshServerCreateControl\\([[:space:]]*domainUrl[[:space:]]*,[[:space:]]*authCookie' "
                f"{REMOTE_VIEWS}/{name} && grep -F '{AUTH_MARKER}' {REMOTE_VIEWS}/{name}",
            ],
            check=False,
            capture=True,
        )
        checked[name] = {
            "autoconnect": auto.returncode == 0,
            "authcookie": auth.returncode == 0,
        }
    # Critical path for WXQK Chinese UI
    critical = [
        n
        for n in (
            "default-min.handlebars",
            "translations/default-min_zh-chs.handlebars",
            "default.handlebars",
            "translations/default_zh-chs.handlebars",
        )
        if n in checked
    ]
    if not critical:
        critical = list(checked.keys())[:2]
    ok = bool(critical) and all(checked[n]["autoconnect"] and checked[n]["authcookie"] for n in critical)
    return {
        "ok": ok,
        "code": "OK" if ok else "PATCH_MISSING",
        "version": ver,
        "views": checked,
        "critical": critical,
    }


def ensure_compose_view_mounts_note() -> str:
    return (
        "WXQK patches (authcookie + autoconnect) are re-applied by manage.py "
        f"bootstrap/up onto {CONTAINER} views (including translations/*zh*). "
        f"Persist copies live in {PERSIST_DIR}."
    )


TLS_OFFLOAD_DOCKER = "127.0.0.1,172.16.0.0/12"


def normalize_tls_offload(settings: dict) -> bool:
    """Ensure TlsOffload trusts Docker bridge X-Forwarded-For. Returns changed?"""
    cur = settings.get("TlsOffload")
    if cur is True:
        return False
    if isinstance(cur, list):
        joined = ",".join(str(x) for x in cur)
    else:
        joined = str(cur or "").strip()
    if not joined or joined.lower() in ("false", "0", "none"):
        return False
    if "172.16.0.0/12" in joined or "172.18.0.1" in joined:
        return False
    if "127.0.0.1" in joined:
        settings["TlsOffload"] = TLS_OFFLOAD_DOCKER
        return True
    return False


if __name__ == "__main__":
    import argparse

    p = argparse.ArgumentParser(description="WXQK MeshCentral patches (1.2.4 only)")
    p.add_argument("cmd", choices=("apply", "verify"))
    p.add_argument("--restart", dest="restart", action="store_true", default=True)
    p.add_argument("--no-restart", dest="restart", action="store_false")
    args = p.parse_args()
    if args.cmd == "apply":
        out = apply_autoconnect_patch(restart=bool(args.restart))
    else:
        out = verify_autoconnect_patch()
    print(json.dumps(out, ensure_ascii=False, indent=2))
    raise SystemExit(0 if out.get("ok") else 1)
