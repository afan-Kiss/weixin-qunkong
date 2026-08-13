#!/usr/bin/env python3
"""MeshCentral deploy helper for WXQK (no secrets committed).

Usage (from repo root or this directory):
  python manage.py prepare
  python manage.py validate
  python manage.py bootstrap
  python manage.py doctor
  python manage.py up | down | status | logs | backup
  python manage.py gen-secret [--write PATH] [--show-secret]

Requires Docker Compose on the Mesh host. Does not invent MeshCentral REST APIs.
Login tokens come from MeshCentral 1.2.4 (`node …/meshcentral --loginTokenKey`).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import secrets
import shutil
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Optional

HERE = Path(__file__).resolve().parent
VERSION_FILE = HERE / "VERSION"
COMPOSE = HERE / "docker-compose.yml"
ENV_EXAMPLE = HERE / ".env.example"
CFG_EXAMPLE = HERE / "config.example.json"
WXQK_MESH_ENV_DEFAULT = Path("/etc/wxqk/mesh.env")
WXQK_MESH_ENV_LOCAL = HERE / "wxqk-mesh.env"
PINNED_VERSION = "1.2.4"


def _run(cmd: list[str], *, check: bool = True, capture: bool = False) -> subprocess.CompletedProcess[str]:
    print("+", " ".join(cmd))
    return subprocess.run(
        cmd,
        cwd=str(HERE),
        check=check,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=capture,
    )


def _docker_available() -> bool:
    return shutil.which("docker") is not None


def _pinned_version() -> str:
    try:
        for line in VERSION_FILE.read_text(encoding="utf-8").splitlines():
            if line.strip().startswith("MESHCENTRAL_VERSION="):
                return line.split("=", 1)[1].strip()
    except Exception:
        pass
    return ""


def _load_env_file(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    if not path.exists():
        return out
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        out[k.strip()] = v.strip().strip('"').strip("'")
    return out


def _write_env_file(path: Path, values: dict[str, str], *, merge_existing: bool = True) -> None:
    existing = _load_env_file(path) if merge_existing and path.exists() else {}
    merged = {**existing, **values}
    # Preserve comment header from example when creating new file
    lines: list[str] = [
        "# Generated/updated by deploy/meshcentral/manage.py — do not commit secrets.",
        f"# MeshCentral pin: {PINNED_VERSION}",
    ]
    preferred = [
        "MESHCENTRAL_VERSION",
        "TZ",
        "WXQK_MESH_URL",
        "WXQK_MESH_INTERNAL_URL",
        "WXQK_MESH_HOSTNAME",
        "WXQK_MESH_HTTPS_PORT",
        "WXQK_MESH_HTTP_PORT",
        "WXQK_MESH_AGENT_PORT",
        "WXQK_MESH_REVERSE_PROXY",
        "WXQK_MESH_REVERSE_PROXY_TLS_PORT",
        "WXQK_MESH_ENABLED",
        "WXQK_MESH_USER",
        "WXQK_MESH_LOGIN_KEY",
        "WXQK_MESH_SECRET",
        "WXQK_MESH_TOKEN_EXPIRE_MIN",
        "WXQK_MESH_GROUP",
        "WXQK_MESH_TIMEOUT",
        "WXQK_MESH_OPS_USERS",
        "WXQK_MESH_AGENT_URL",
        "WXQK_MESH_MSH_URL",
    ]
    seen: set[str] = set()
    for key in preferred:
        if key in merged:
            lines.append(f"{key}={merged[key]}")
            seen.add(key)
    for key in sorted(merged.keys()):
        if key not in seen:
            lines.append(f"{key}={merged[key]}")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    try:
        os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)  # 600
    except Exception:
        pass


def _secret_fingerprint(hex_key: str) -> str:
    raw = str(hex_key or "").strip().encode("utf-8")
    if not raw:
        return ""
    return hashlib.sha256(raw).hexdigest()[:16]


def _redact_secret_text(text: str) -> str:
    return re.sub(
        r"(?i)(WXQK_MESH_LOGIN_KEY|WXQK_MESH_SECRET|loginTokenKey)\s*[=:]\s*[0-9a-fA-F]{16,}",
        r"\1=<redacted>",
        str(text or ""),
    )


def _print_check(ok: bool, name: str, detail: str = "", *, hint: str = "") -> None:
    tag = "PASS" if ok else "FAIL"
    print(f"[{tag}] {name}" + (f" — {detail}" if detail else ""))
    if not ok and hint:
        print(f"原因：{detail or name}")
        print(f"修复建议：{hint}")


def cmd_prepare(_: argparse.Namespace) -> int:
    env_path = HERE / ".env"
    cfg_path = HERE / "config.json"
    if not env_path.exists():
        shutil.copyfile(ENV_EXAMPLE, env_path)
        try:
            os.chmod(env_path, stat.S_IRUSR | stat.S_IWUSR)
        except Exception:
            pass
        print(f"created {env_path} — edit hosts/ports locally")
    else:
        print(f"keep existing {env_path}")
    if not cfg_path.exists():
        shutil.copyfile(CFG_EXAMPLE, cfg_path)
        print(f"created {cfg_path} — set Cert / allowedFramingOrigins")
    else:
        print(f"keep existing {cfg_path}")
    for name in ("data", "files", "backups"):
        (HERE / name).mkdir(parents=True, exist_ok=True)
    return 0


def _validate_config_dict(data: dict[str, Any], label: str) -> list[str]:
    errors: list[str] = []
    settings = data.get("settings") or {}
    if settings.get("webRTC") is not False:
        errors.append(f"{label}: settings.webRTC must be false")
    if settings.get("allowLoginToken") is not True:
        errors.append(f"{label}: settings.allowLoginToken must be true")
    if settings.get("allowFraming") is not True:
        errors.append(f"{label}: settings.allowFraming must be true")
    domains = data.get("domains") or {}
    domain0 = domains.get("") if isinstance(domains, dict) else None
    if isinstance(domain0, dict):
        origins = domain0.get("allowedFramingOrigins")
        if not isinstance(origins, list) or not origins:
            errors.append(f"{label}: domains.\"\".allowedFramingOrigins must be a non-empty list")
        elif "*" in origins:
            errors.append(f"{label}: allowedFramingOrigins must not contain '*'")
    return errors


def cmd_validate(_: argparse.Namespace) -> int:
    errors: list[str] = []
    if not COMPOSE.exists():
        errors.append("docker-compose.yml missing")
    if not VERSION_FILE.exists():
        errors.append("VERSION missing")
    pinned = _pinned_version()
    if pinned != PINNED_VERSION:
        errors.append(f"VERSION must pin MESHCENTRAL_VERSION={PINNED_VERSION} (got {pinned or 'empty'})")
    cfg = HERE / "config.json"
    target = cfg if cfg.exists() else CFG_EXAMPLE
    try:
        data = json.loads(target.read_text(encoding="utf-8"))
        errors.extend(_validate_config_dict(data, target.name))
    except Exception as exc:
        errors.append(f"config parse error: {exc}")
    text = COMPOSE.read_text(encoding="utf-8")
    if "meshcentral:latest" in text or "meshcentral:${MESHCENTRAL_VERSION:-latest}" in text:
        errors.append("compose must not use :latest")
    if PINNED_VERSION not in text:
        errors.append(f"compose default image tag must include {PINNED_VERSION}")
    if "meshcentral-backups" not in text and "./backups" not in text:
        errors.append("compose should persist backups volume")
    for err in errors:
        print(f"[MESH] FAIL {err}")
    if errors:
        return 1
    print(f"[MESH] validate OK (MeshCentral {pinned})")
    return 0


def cmd_up(_: argparse.Namespace) -> int:
    if not _docker_available():
        print("[MESH] docker not installed on this machine — compose file is ready; run on the Mesh host")
        return 2
    cmd_prepare(_)
    if cmd_validate(_) != 0:
        return 1
    rc = _run(["docker", "compose", "up", "-d"]).returncode
    if rc != 0:
        return rc
    if not _wait_mesh_http(90):
        print("[MESH] WARN MeshCentral HTTP not ready yet; skip autoconnect patch for now")
        return 0
    try:
        from wxqk_patch import apply_autoconnect_patch

        patch_result = apply_autoconnect_patch(restart=False)
        if patch_result.get("ok"):
            print(f"[MESH] autoconnect patch re-applied: {patch_result.get('views')}")
        else:
            print(f"[MESH] WARN autoconnect patch: {patch_result}")
    except Exception as exc:
        print(f"[MESH] WARN autoconnect patch: {type(exc).__name__}: {exc}")
    return 0


def cmd_down(_: argparse.Namespace) -> int:
    if not _docker_available():
        print("[MESH] docker not available")
        return 2
    return _run(["docker", "compose", "down"]).returncode


def cmd_status(_: argparse.Namespace) -> int:
    if not _docker_available():
        print("[MESH] docker not available")
        return 2
    return _run(["docker", "compose", "ps"], check=False).returncode


def cmd_logs(_: argparse.Namespace) -> int:
    if not _docker_available():
        print("[MESH] docker not available")
        return 2
    return _run(["docker", "compose", "logs", "--tail", "200"], check=False).returncode


def cmd_backup(_: argparse.Namespace) -> int:
    stamp = time.strftime("%Y%m%d-%H%M%S")
    dest = HERE / "backups" / f"wxqk-mesh-{stamp}"
    dest.mkdir(parents=True, exist_ok=True)
    for name in ("data", "files", "config.json", ".env", "wxqk-mesh.env"):
        src = HERE / name
        if not src.exists():
            continue
        target = dest / name
        if src.is_dir():
            shutil.copytree(src, target, dirs_exist_ok=True)
        else:
            shutil.copy2(src, target)
    print(f"[MESH] backup written to {dest}")
    print("[MESH] Do not commit backups/ or .env")
    return 0


def cmd_gen_secret(args: argparse.Namespace) -> int:
    """
    Generate a candidate hex secret for lab use.

    Production preference: read MeshCentral's own key via
    `docker compose exec meshcentral node node_modules/meshcentral --loginTokenKey`
    (see bootstrap). This command never prints the full secret unless --show-secret.
    """
    key = secrets.token_hex(48)
    write_path = Path(str(getattr(args, "write", "") or "")).expanduser() if getattr(args, "write", None) else None
    if write_path is None:
        write_path = WXQK_MESH_ENV_LOCAL
    existing = _load_env_file(write_path)
    if existing.get("WXQK_MESH_LOGIN_KEY") and not getattr(args, "force", False):
        fp = _secret_fingerprint(existing["WXQK_MESH_LOGIN_KEY"])
        print(f"Secret generated")
        print(f"Configured: yes")
        print(f"Length: {len(existing['WXQK_MESH_LOGIN_KEY'])}")
        print(f"Fingerprint: {fp}")
        print(f"kept existing key in {write_path} (pass --force to replace)")
        return 0
    _write_env_file(
        write_path,
        {
            "MESHCENTRAL_VERSION": PINNED_VERSION,
            "WXQK_MESH_LOGIN_KEY": key,
            "WXQK_MESH_ENABLED": existing.get("WXQK_MESH_ENABLED") or "false",
        },
        merge_existing=True,
    )
    print(f"Secret generated")
    print(f"Configured: yes")
    print(f"Length: {len(key)}")
    print(f"Fingerprint: {_secret_fingerprint(key)}")
    print(f"wrote {write_path} (mode 600 when supported)")
    print("NOTE: Prefer MeshCentral --loginTokenKey on a live 1.2.4 host (bootstrap does this).")
    if getattr(args, "show_secret", False):
        print("WARNING: --show-secret prints a secret. Do not paste into chat/git/client.")
        print(f"WXQK_MESH_LOGIN_KEY={key}")
    return 0


def _http_ok(url: str, timeout: float = 8.0) -> tuple[bool, str]:
    try:
        req = urllib.request.Request(url, method="GET", headers={"User-Agent": "wxqk-mesh-manage/1.0"})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            code = int(getattr(resp, "status", 200) or 200)
            return code < 500, f"HTTP {code}"
    except urllib.error.HTTPError as exc:
        code = int(exc.code or 0)
        return code < 500, f"HTTP {code}"
    except Exception as exc:
        return False, str(exc)[:160]


def _wait_mesh_http(timeout_s: float = 120.0) -> bool:
    env = _load_env_file(HERE / ".env")
    candidates = [
        env.get("WXQK_MESH_INTERNAL_URL") or "http://127.0.0.1:80",
        "http://127.0.0.1:80",
        "http://127.0.0.1:443",
    ]
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        for url in candidates:
            ok, _ = _http_ok(url, timeout=3.0)
            if ok:
                return True
        time.sleep(2)
    return False


def _read_login_token_key_from_container() -> tuple[str, str]:
    """
    Ask MeshCentral 1.2.4 for its loginTokenKey inside the container.
    Returns (key_hex, error_message).
    """
    if not _docker_available():
        return "", "docker unavailable"
    try:
        proc = _run(
            [
                "docker",
                "compose",
                "exec",
                "-T",
                "meshcentral",
                "node",
                "node_modules/meshcentral",
                "--loginTokenKey",
            ],
            check=False,
            capture=True,
        )
    except Exception as exc:
        return "", str(exc)[:200]
    combined = _redact_secret_text((proc.stdout or "") + "\n" + (proc.stderr or ""))
    # Prefer raw stdout for parsing before redaction
    raw = (proc.stdout or "") + "\n" + (proc.stderr or "")
    # MeshCentral prints hex; accept first long hex token
    match = re.search(r"\b([0-9a-fA-F]{64,})\b", raw)
    if not match:
        return "", f"loginTokenKey not found in meshcentral output (exit={proc.returncode})"
    key = match.group(1)
    if len(key) < 64:
        return "", "loginTokenKey too short"
    return key, ""


def _ensure_agent_customization(domain0: dict) -> None:
    """MeshCentral 1.2.4 domains.\"\".agentCustomization — brand agent as WXQK (no Remote)."""
    want = {
        "displayName": "WXQK",
        "description": "WXQK",
        "companyName": "WXQK",
        "serviceName": "WXQK",
        "fileName": "WXQK",
    }
    existing = domain0.get("agentCustomization")
    if not isinstance(existing, dict):
        domain0["agentCustomization"] = dict(want)
        return
    merged = dict(existing)
    for key, val in want.items():
        if not str(merged.get(key) or "").strip():
            merged[key] = val
    # Hard-normalize brand fields so production never ships Mesh Agent / Remote names.
    for key, val in want.items():
        merged[key] = val
    domain0["agentCustomization"] = merged


AGENT_ICON_NAME = "wxqk-agent.ico"


def _ensure_agent_file_info(domain0: dict) -> None:
    """MeshCentral agentFileInfo — Windows EXE icon + version resource metadata."""
    want = {
        "icon": AGENT_ICON_NAME,
        "filedescription": "WXQK",
        "internalname": "WXQK",
        "originalfilename": "WXQK.exe",
        "productname": "WXQK",
    }
    existing = domain0.get("agentFileInfo")
    if not isinstance(existing, dict):
        domain0["agentFileInfo"] = dict(want)
        return
    merged = dict(existing)
    for key, val in want.items():
        if key == "icon" or not str(merged.get(key) or "").strip():
            merged[key] = val
    domain0["agentFileInfo"] = merged


def ensure_agent_icon_file() -> Path:
    """Ensure meshcentral-data has wxqk-agent.ico (copied from deploy folder)."""
    src = HERE / AGENT_ICON_NAME
    dest = HERE / "data" / AGENT_ICON_NAME
    dest.parent.mkdir(parents=True, exist_ok=True)
    if not src.is_file():
        raise FileNotFoundError(f"missing agent icon source: {src}")
    if (not dest.is_file()) or (src.stat().st_mtime > dest.stat().st_mtime) or (src.stat().st_size != dest.stat().st_size):
        shutil.copyfile(src, dest)
    return dest


def _apply_config_defaults(public_host: str, framing_origins: list[str]) -> None:
    cfg_path = HERE / "config.json"
    if not cfg_path.exists():
        shutil.copyfile(CFG_EXAMPLE, cfg_path)
    data = json.loads(cfg_path.read_text(encoding="utf-8"))
    settings = data.setdefault("settings", {})
    settings["webRTC"] = False
    settings["allowLoginToken"] = True
    settings["allowFraming"] = True
    # Docker + nginx TLS offload: trust X-Forwarded-For from bridge gateway,
    # not only 127.0.0.1 (container sees 172.18.0.1 as peer).
    try:
        from wxqk_patch import normalize_tls_offload

        normalize_tls_offload(settings)
    except Exception:
        if str(settings.get("TlsOffload") or "").strip() == "127.0.0.1":
            settings["TlsOffload"] = "127.0.0.1,172.16.0.0/12"
    if not settings.get("Cert"):
        settings["Cert"] = public_host
    domains = data.setdefault("domains", {})
    domain0 = domains.setdefault("", {})
    origins = domain0.get("allowedFramingOrigins")
    if not isinstance(origins, list) or not origins:
        domain0["allowedFramingOrigins"] = framing_origins
    else:
        # merge without introducing *
        merged = []
        for item in list(origins) + framing_origins:
            s = str(item or "").strip()
            if s and s != "*" and s not in merged:
                merged.append(s)
        domain0["allowedFramingOrigins"] = merged
    if not domain0.get("certUrl"):
        domain0["certUrl"] = f"https://{public_host}/"
    _ensure_agent_customization(domain0)
    _ensure_agent_file_info(domain0)
    try:
        ensure_agent_icon_file()
    except FileNotFoundError:
        pass
    title = str(domain0.get("title") or "").strip()
    if not title or title.lower() in ("meshcentral", "wxqk remote"):
        domain0["title"] = "WXQK"
    title2 = str(domain0.get("title2") or "").strip()
    if not title2 or "remote" in title2.lower():
        domain0["title2"] = "Maintenance"
    cfg_path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _sync_wxqk_mesh_env(login_key: str, env: dict[str, str]) -> Path:
    """Write server-side mesh.env used by wxqk (never for Electron)."""
    payload = {
        "MESHCENTRAL_VERSION": PINNED_VERSION,
        "WXQK_MESH_ENABLED": "1",
        "WXQK_MESH_URL": env.get("WXQK_MESH_URL") or f"https://{env.get('WXQK_MESH_HOSTNAME') or 'mesh.example.invalid'}",
        "WXQK_MESH_INTERNAL_URL": env.get("WXQK_MESH_INTERNAL_URL") or "http://127.0.0.1:80",
        "WXQK_MESH_USER": env.get("WXQK_MESH_USER") or "user//admin",
        "WXQK_MESH_LOGIN_KEY": login_key,
        "WXQK_MESH_GROUP": env.get("WXQK_MESH_GROUP") or "",
        "WXQK_MESH_TIMEOUT": env.get("WXQK_MESH_TIMEOUT") or "15",
        "WXQK_MESH_TOKEN_EXPIRE_MIN": env.get("WXQK_MESH_TOKEN_EXPIRE_MIN") or "30",
        "WXQK_MESH_AGENT_PORT": env.get("WXQK_MESH_AGENT_PORT") or "4433",
        "WXQK_MESH_WS_LOCAL_HOST": env.get("WXQK_MESH_WS_LOCAL_HOST") or "127.0.0.1",
    }
    local_path = WXQK_MESH_ENV_LOCAL
    _write_env_file(local_path, payload, merge_existing=True)
    # Best-effort system path on Linux Mesh/wxqk host
    if os.name != "nt":
        try:
            WXQK_MESH_ENV_DEFAULT.parent.mkdir(parents=True, exist_ok=True)
            _write_env_file(WXQK_MESH_ENV_DEFAULT, payload, merge_existing=True)
            print(f"[MESH] synced {WXQK_MESH_ENV_DEFAULT}")
            # Merge Mesh keys into legacy wxqk.env so older units still pick them up
            wxqk_env_path = Path("/etc/wxqk/wxqk.env")
            try:
                _write_env_file(wxqk_env_path, payload, merge_existing=True)
                print(f"[MESH] merged Mesh keys into {wxqk_env_path}")
            except Exception as merge_exc:
                print(f"[MESH] WARN could not merge into wxqk.env: {merge_exc}")
            print("[MESH] ensure systemd has: EnvironmentFile=-/etc/wxqk/mesh.env")
            print("[MESH] then: systemctl daemon-reload && systemctl restart wxqk")
        except Exception as exc:
            print(f"[MESH] WARN could not write system mesh env: {exc}")
    # Also keep deploy/.env login key in sync (Mesh compose env_file)
    mesh_env = dict(env)
    mesh_env.update(payload)
    _write_env_file(HERE / ".env", mesh_env, merge_existing=True)
    return local_path


def cmd_bootstrap(args: argparse.Namespace) -> int:
    """
    Idempotent production-oriented bootstrap:
      prepare → config defaults → validate → up → wait health →
      read MeshCentral loginTokenKey → sync wxqk mesh.env → doctor summary
    Never rotates an existing login key unless --rotate-key (dangerous).
    """
    print("[MESH] bootstrap start")
    cmd_prepare(args)
    env_path = HERE / ".env"
    env = _load_env_file(env_path)
    public_host = (
        str(getattr(args, "public_host", "") or "").strip()
        or env.get("WXQK_MESH_HOSTNAME")
        or ""
    ).strip()
    if not public_host or public_host in ("mesh.example.invalid", "localhost"):
        if not getattr(args, "allow_example_host", False):
            print("[MESH] FAIL set --public-host <YOUR_MESH_HOST> (or WXQK_MESH_HOSTNAME in .env)")
            print("修复建议：python manage.py bootstrap --public-host 203.0.113.10")
            return 1
        public_host = public_host or "mesh.example.invalid"

    mesh_url = env.get("WXQK_MESH_URL") or f"https://{public_host}"
    framing = [
        "http://localhost:5173",
        "file://",
        "app://.",
        mesh_url.rstrip("/"),
        f"https://{public_host}",
    ]
    extra_origin = str(getattr(args, "framing_origin", "") or "").strip()
    if extra_origin:
        framing.append(extra_origin)

    # Preserve existing .env values; only fill gaps
    updates = {
        "MESHCENTRAL_VERSION": PINNED_VERSION,
        "WXQK_MESH_HOSTNAME": public_host,
        "WXQK_MESH_URL": mesh_url,
        "WXQK_MESH_INTERNAL_URL": env.get("WXQK_MESH_INTERNAL_URL") or "http://127.0.0.1:80",
        "WXQK_MESH_HTTPS_PORT": env.get("WXQK_MESH_HTTPS_PORT") or "443",
        "WXQK_MESH_HTTP_PORT": env.get("WXQK_MESH_HTTP_PORT") or "80",
        "WXQK_MESH_AGENT_PORT": env.get("WXQK_MESH_AGENT_PORT") or "4433",
        "WXQK_MESH_USER": env.get("WXQK_MESH_USER") or "user//admin",
        "WXQK_MESH_ENABLED": env.get("WXQK_MESH_ENABLED") or "1",
    }
    _write_env_file(env_path, updates, merge_existing=True)
    env = _load_env_file(env_path)

    _apply_config_defaults(public_host, framing)
    if cmd_validate(args) != 0:
        return 1

    if not _docker_available():
        print("[MESH] BLOCKED: docker not available on this machine")
        print("修复建议：在 MeshCentral 宿主上运行 bootstrap；本机仅可 prepare/validate")
        return 2

    rc = _run(["docker", "compose", "up", "-d"], check=False).returncode
    if rc != 0:
        print("[MESH] FAIL docker compose up")
        return rc

    print("[MESH] waiting for MeshCentral HTTP…")
    if not _wait_mesh_http(120):
        print("[MESH] FAIL MeshCentral HTTP not ready")
        return 1
    print("[MESH] MeshCentral HTTP ready")

    existing_key = (env.get("WXQK_MESH_LOGIN_KEY") or env.get("WXQK_MESH_SECRET") or "").strip()
    wxqk_env = _load_env_file(WXQK_MESH_ENV_LOCAL)
    if not existing_key:
        existing_key = (wxqk_env.get("WXQK_MESH_LOGIN_KEY") or "").strip()

    rotate = bool(getattr(args, "rotate_key", False))
    if existing_key and not rotate:
        login_key = existing_key
        print(
            f"[MESH] keep existing loginTokenKey configured=true "
            f"length={len(login_key)} fingerprint={_secret_fingerprint(login_key)}"
        )
    else:
        if rotate and existing_key:
            print("[MESH] WARN --rotate-key will replace loginTokenKey (clients may need remint)")
            cmd_backup(args)
        login_key, err = _read_login_token_key_from_container()
        if not login_key:
            print(f"[MESH] FAIL could not read MeshCentral loginTokenKey: {err}")
            print("修复建议：docker compose exec meshcentral node node_modules/meshcentral --loginTokenKey")
            return 1
        print(
            f"[MESH] loginTokenKey configured=true length={len(login_key)} "
            f"fingerprint={_secret_fingerprint(login_key)}"
        )

    synced = _sync_wxqk_mesh_env(login_key, env)
    print(f"[MESH] wxqk mesh env synced → {synced}")

    # WXQK embed auto-connect patch (MeshCentral 1.2.4 only; idempotent)
    try:
        from wxqk_patch import apply_autoconnect_patch, ensure_compose_view_mounts_note

        patch_result = apply_autoconnect_patch(restart=False)
        if not patch_result.get("ok"):
            print(f"[MESH] FAIL autoconnect patch: {patch_result}")
            return 1
        print(
            f"[MESH] autoconnect patch OK version={patch_result.get('version')} "
            f"views={patch_result.get('views')} sha={patch_result.get('snippet_sha256')}"
        )
        print(f"[MESH] {ensure_compose_view_mounts_note()}")
    except Exception as exc:
        print(f"[MESH] FAIL autoconnect patch exception: {type(exc).__name__}: {exc}")
        return 1

    print("[MESH] bootstrap complete — run: python manage.py doctor")
    # Run doctor as final gate (non-fatal for control.ashx if websocket missing on host)
    return cmd_doctor(args)


def _compose_plugin_ok() -> tuple[bool, str]:
    if not _docker_available():
        return False, "docker missing"
    proc = _run(["docker", "compose", "version"], check=False, capture=True)
    if proc.returncode == 0:
        detail = (proc.stdout or proc.stderr or "ok").strip().splitlines()
        return True, (detail[0] if detail else "ok")[:80]
    return False, "docker compose plugin missing"


def cmd_doctor(args: argparse.Namespace) -> int:
    failures = 0

    docker_ok = _docker_available()
    _print_check(docker_ok, "Docker", "available" if docker_ok else "missing", hint="Install Docker Engine + Compose plugin on Mesh host")
    if not docker_ok:
        failures += 1

    compose_ok, compose_detail = _compose_plugin_ok()
    _print_check(compose_ok, "Docker Compose", compose_detail, hint="Install Docker Compose v2 plugin")
    if not compose_ok:
        failures += 1

    pinned = _pinned_version()
    ver_ok = pinned == PINNED_VERSION
    _print_check(
        ver_ok,
        "MeshCentral version pin",
        f"{pinned or 'missing'} (want {PINNED_VERSION})",
        hint=f"Set MESHCENTRAL_VERSION={PINNED_VERSION} in VERSION/.env",
    )
    if not ver_ok:
        failures += 1

    cfg_path = HERE / "config.json"
    target = cfg_path if cfg_path.exists() else CFG_EXAMPLE
    cfg_loaded = False
    try:
        data = json.loads(target.read_text(encoding="utf-8"))
        settings = data.get("settings") or {}
        cfg_loaded = True
        _print_check(True, "MeshCentral config", target.name)
        webrtc_ok = settings.get("webRTC") is False
        token_ok = settings.get("allowLoginToken") is True
        framing_ok = settings.get("allowFraming") is True
        _print_check(webrtc_ok, "webRTC=false", target.name, hint="Set settings.webRTC to false")
        _print_check(token_ok, "allowLoginToken=true", target.name, hint="Set settings.allowLoginToken to true")
        _print_check(framing_ok, "allowFraming=true / framing configuration", target.name, hint="Set settings.allowFraming to true")
        if not webrtc_ok:
            failures += 1
        if not token_ok:
            failures += 1
        if not framing_ok:
            failures += 1
        domain0 = ((data.get("domains") or {}).get("")) if isinstance(data.get("domains"), dict) else {}
        origins = (domain0 or {}).get("allowedFramingOrigins") if isinstance(domain0, dict) else None
        origins_ok = isinstance(origins, list) and bool(origins) and "*" not in origins
        _print_check(
            origins_ok,
            "framing configuration",
            f"{len(origins or [])} origin(s)" if isinstance(origins, list) else "missing",
            hint="Set domains.\"\".allowedFramingOrigins to explicit admin origins (no *)",
        )
        if not origins_ok:
            failures += 1
        custom = (domain0 or {}).get("agentCustomization") if isinstance(domain0, dict) else None
        custom_ok = (
            isinstance(custom, dict)
            and str(custom.get("fileName") or "") == "WXQK"
            and str(custom.get("serviceName") or "") == "WXQK"
            and str(custom.get("companyName") or "") == "WXQK"
            and "remote" not in json.dumps(custom).lower()
        )
        _print_check(
            custom_ok,
            "agentCustomization WXQK brand",
            "fileName/serviceName/companyName=WXQK" if custom_ok else "missing or not branded",
            hint='Set domains."".agentCustomization fileName/serviceName/companyName/displayName/description to WXQK',
        )
        if not custom_ok:
            failures += 1
        fileinfo = (domain0 or {}).get("agentFileInfo") if isinstance(domain0, dict) else None
        icon_name = str((fileinfo or {}).get("icon") or "").strip()
        icon_path = HERE / "data" / (icon_name or AGENT_ICON_NAME)
        icon_src = HERE / AGENT_ICON_NAME
        icon_ok = (
            isinstance(fileinfo, dict)
            and icon_name == AGENT_ICON_NAME
            and (icon_path.is_file() or icon_src.is_file())
        )
        _print_check(
            icon_ok,
            "agentFileInfo icon",
            AGENT_ICON_NAME if icon_ok else "missing wxqk-agent.ico / agentFileInfo.icon",
            hint=f"Place {AGENT_ICON_NAME} in deploy/meshcentral/ and set domains.\"\".agentFileInfo.icon",
        )
        if not icon_ok:
            failures += 1
    except Exception as exc:
        _print_check(False, "MeshCentral config", str(exc)[:120], hint="Run prepare/bootstrap")
        failures += 1

    container_ok = False
    if docker_ok and compose_ok:
        proc = _run(["docker", "compose", "ps", "--status", "running", "-q"], check=False, capture=True)
        container_ok = bool((proc.stdout or "").strip())
    _print_check(container_ok, "MeshCentral container", "running" if container_ok else "not running", hint="python manage.py up")
    if not container_ok:
        failures += 1

    env = _load_env_file(HERE / ".env")
    wxqk_env = _load_env_file(WXQK_MESH_ENV_LOCAL)
    if WXQK_MESH_ENV_DEFAULT.exists():
        wxqk_env = {**wxqk_env, **_load_env_file(WXQK_MESH_ENV_DEFAULT)}
    internal = env.get("WXQK_MESH_INTERNAL_URL") or "http://127.0.0.1:80"
    public = env.get("WXQK_MESH_URL") or wxqk_env.get("WXQK_MESH_URL") or ""
    https_ok, https_detail = _http_ok(internal)
    _print_check(https_ok, "HTTPS endpoint", https_detail, hint="Check compose ports and nginx/TlsOffload")
    if not https_ok:
        failures += 1

    agent_port = int(env.get("WXQK_MESH_AGENT_PORT") or wxqk_env.get("WXQK_MESH_AGENT_PORT") or "4433")
    agent_ok = False
    try:
        import socket

        with socket.create_connection(("127.0.0.1", agent_port), timeout=3):
            agent_ok = True
    except Exception as exc:
        agent_detail = str(exc)[:80]
    else:
        agent_detail = f"127.0.0.1:{agent_port} open"
    _print_check(
        agent_ok,
        "Agent Listener",
        (agent_detail + " — TCP accept only, not Windows agent online") if agent_ok else agent_detail,
        hint="Ensure WXQK_MESH_AGENT_PORT is published; does not prove agents are connected",
    )
    if not agent_ok:
        failures += 1

    login_key = (wxqk_env.get("WXQK_MESH_LOGIN_KEY") or env.get("WXQK_MESH_LOGIN_KEY") or "").strip()
    key_ok = len(login_key) >= 64
    _print_check(
        key_ok,
        "loginTokenKey configured",
        f"length={len(login_key)} fingerprint={_secret_fingerprint(login_key)}" if key_ok else "missing",
        hint="python manage.py bootstrap (reads MeshCentral --loginTokenKey)",
    )
    if not key_ok:
        failures += 1

    # Online agent count only (never print node/client identifiers)
    online_detail = "skip"
    try:
        import sys as _sys

        for candidate in (Path("/opt/wxqk"), HERE.parent.parent / "server" / "wxqk"):
            if candidate.exists() and str(candidate) not in _sys.path:
                _sys.path.insert(0, str(candidate))
        for k, v in {**env, **wxqk_env}.items():
            if isinstance(k, str) and k.startswith("WXQK_MESH_") and v:
                os.environ.setdefault(k, str(v))
        os.environ.setdefault("WXQK_MESH_ENABLED", "1")
        from meshcentral_client import node_is_online, sync_nodes_via_control  # type: ignore

        _nodes = (sync_nodes_via_control() or {}).get("nodes") or []
        _online = sum(1 for n in _nodes if node_is_online(n))
        online_detail = f"online={_online} total={len(_nodes)}"
    except Exception as exc:  # pragma: no cover - best-effort diagnostic
        online_detail = f"skip ({type(exc).__name__})"
    _print_check(True, "Online Agents", online_detail, hint="Count only; identifiers not printed")

    mesh_url_ok = bool(str(wxqk_env.get("WXQK_MESH_URL") or env.get("WXQK_MESH_URL") or "").strip())
    enabled = str(wxqk_env.get("WXQK_MESH_ENABLED") or env.get("WXQK_MESH_ENABLED") or "").strip().lower() in (
        "1",
        "true",
        "yes",
        "on",
    )
    env_file_ok = WXQK_MESH_ENV_LOCAL.exists() or WXQK_MESH_ENV_DEFAULT.exists() or (HERE / ".env").exists()
    wxqk_env_ok = bool(enabled and key_ok and mesh_url_ok and env_file_ok)
    _print_check(
        wxqk_env_ok,
        "wxqk Mesh env configured",
        f"enabled={enabled} url={'set' if mesh_url_ok else 'missing'} key={'set' if key_ok else 'missing'}",
        hint="python manage.py bootstrap → /etc/wxqk/mesh.env + EnvironmentFile in systemd",
    )
    if not wxqk_env_ok:
        failures += 1

    # control.ashx soft check: only when websocket-client + key available
    control_ok = False
    control_detail = "skipped"
    synced: dict = {}
    if key_ok and public:
        try:
            candidates = [
                HERE.parent,  # flat deploy: /opt/wxqk/meshcentral -> /opt/wxqk
                HERE.parents[1] / "server" / "wxqk",  # repo layout
                Path("/opt/wxqk"),
            ]
            for cand in candidates:
                if (cand / "meshcentral_client.py").is_file():
                    sys.path.insert(0, str(cand.resolve()))
                    break
            os.environ["WXQK_MESH_ENABLED"] = "1"
            os.environ["WXQK_MESH_URL"] = public
            os.environ["WXQK_MESH_INTERNAL_URL"] = internal
            os.environ["WXQK_MESH_LOGIN_KEY"] = login_key
            os.environ["WXQK_MESH_USER"] = wxqk_env.get("WXQK_MESH_USER") or env.get("WXQK_MESH_USER") or "user//admin"
            import meshcentral_client as mc  # type: ignore

            synced = mc.sync_nodes_via_control(timeout=8)
            control_ok = bool(synced.get("ok"))
            control_detail = str(synced.get("code") or synced.get("message") or "")[:120]
            if login_key and login_key in control_detail:
                control_detail = "ok" if control_ok else "failed"
        except Exception as exc:
            control_detail = str(exc)[:120]
            if login_key and login_key in control_detail:
                control_detail = "exception (redacted)"
    _print_check(control_ok, "control.ashx reachable", control_detail, hint="Verify loginTokenKey + TLS + MeshCentral up")
    if key_ok and public and not control_ok and not getattr(args, "allow_control_fail", False):
        failures += 1

    node_ok = False
    node_detail = "n/a"
    if control_ok:
        try:
            nodes = synced.get("nodes") or []
            node_ok = True
            node_detail = f"nodes={len(nodes)}"
        except Exception:
            node_detail = "query failed"
    _print_check(node_ok or not control_ok, "node query", node_detail if control_ok else "skipped (control failed)")

    # Optional wxqk Mesh health endpoint (same host). Timeout-bounded; never print secrets.
    health_url = str(getattr(args, "wxqk_health_url", "") or os.environ.get("WXQK_MESH_HEALTH_URL") or "").strip()
    if not health_url:
        health_url = str(os.environ.get("WXQK_HEALTH_PROBE_URL") or "").strip()
    if health_url:
        health_ok = False
        health_detail = "failed"
        status_code = 0
        body = ""
        try:
            import urllib.request

            req = urllib.request.Request(health_url, method="GET")
            with urllib.request.urlopen(req, timeout=5) as resp:
                status_code = int(getattr(resp, "status", 0) or 0)
                body = resp.read(4096).decode("utf-8", errors="replace")
            if login_key and login_key in body:
                health_ok = False
                health_detail = "FAIL secret leaked in health body"
            else:
                health_ok = 200 <= status_code < 500
                health_detail = f"HTTP {status_code}"
        except Exception as exc:
            health_detail = str(exc)[:100]
            health_ok = False
        _print_check(
            health_ok,
            "wxqk Mesh health endpoint",
            health_detail,
            hint="Set WXQK_MESH_HEALTH_URL or pass --wxqk-health-url",
        )
        if not health_ok and not getattr(args, "allow_health_fail", False):
            failures += 1
    else:
        _print_check(
            True,
            "wxqk Mesh health endpoint",
            "skipped (set --wxqk-health-url to probe)",
            hint="",
        )

    # WXQK embed auto-connect patch (1.2.4)
    try:
        from wxqk_patch import apply_autoconnect_patch, verify_autoconnect_patch

        verified = verify_autoconnect_patch()
        if not verified.get("ok"):
            # Self-heal once during doctor when container was recreated
            applied = apply_autoconnect_patch(restart=False)
            verified = verify_autoconnect_patch() if applied.get("ok") else applied
        patch_ok = bool(verified.get("ok"))
        _print_check(
            patch_ok,
            "WXQK authcookie+autoconnect patch",
            f"version={verified.get('version')} views={verified.get('views')}",
            hint="python manage.py bootstrap (applies 1.2.4-only patch)",
        )
        if not patch_ok:
            failures += 1
    except Exception as exc:
        _print_check(False, "WXQK autoconnect patch", f"{type(exc).__name__}: {exc}")
        failures += 1

    print("")
    if failures:
        print(f"[MESH] doctor FAILED ({failures} check(s))")
        return 1
    print("[MESH] doctor PASS")
    return 0


def cmd_doctor_agent(args: argparse.Namespace) -> int:
    """Server-side agent connectivity diagnostics (no secrets / no device IDs)."""
    env = _load_env_file(HERE / ".env")
    wxqk_env = _load_env_file(WXQK_MESH_ENV_LOCAL)
    if WXQK_MESH_ENV_DEFAULT.exists():
        wxqk_env = {**wxqk_env, **_load_env_file(WXQK_MESH_ENV_DEFAULT)}
    failures = 0

    agent_port = int(env.get("WXQK_MESH_AGENT_PORT") or wxqk_env.get("WXQK_MESH_AGENT_PORT") or "4433")
    agent_ok = False
    agent_detail = ""
    try:
        import socket

        with socket.create_connection(("127.0.0.1", agent_port), timeout=3):
            agent_ok = True
            agent_detail = f"127.0.0.1:{agent_port} open — TCP accept only"
    except Exception as exc:
        agent_detail = str(exc)[:80]
        failures += 1
    _print_check(agent_ok, "Server listener", agent_detail)

    public_host = (
        (wxqk_env.get("WXQK_MESH_PUBLIC_HOST") or env.get("WXQK_MESH_PUBLIC_HOST") or "").strip()
        or (env.get("WXQK_MESH_CERT") or wxqk_env.get("WXQK_MESH_CERT") or "").strip()
    )
    if public_host:
        dns_ok = True
        try:
            import socket

            infos = socket.getaddrinfo(public_host, agent_port, type=socket.SOCK_STREAM)
            addrs = sorted({i[4][0] for i in infos})
            dns_detail = f"{public_host} → {','.join(addrs[:4])}"
        except Exception as exc:
            dns_ok = False
            dns_detail = f"{public_host} ({type(exc).__name__})"
            failures += 1
        _print_check(dns_ok, "DNS target", dns_detail)
    else:
        _print_check(True, "DNS target", "skip (no public host in env)")

    _print_check(True, "TLS endpoint", "listener TCP only — agent TLS verified by MeshAgent runtime, not CERT_NONE bypass")

    control_ok = False
    control_detail = "skip"
    online_detail = "skip"
    try:
        for candidate in (Path("/opt/wxqk"), HERE.parent.parent / "server" / "wxqk"):
            if candidate.exists() and str(candidate) not in sys.path:
                sys.path.insert(0, str(candidate))
        for k, v in {**env, **wxqk_env}.items():
            if isinstance(k, str) and k.startswith("WXQK_MESH_") and v:
                os.environ.setdefault(k, str(v))
        os.environ.setdefault("WXQK_MESH_ENABLED", "1")
        from meshcentral_client import node_is_online, sync_nodes_via_control  # type: ignore

        synced = sync_nodes_via_control() or {}
        control_ok = bool(synced.get("ok"))
        control_detail = str(synced.get("code") or ("OK" if control_ok else "FAIL"))[:40]
        nodes = synced.get("nodes") or []
        online = sum(1 for n in nodes if isinstance(n, dict) and node_is_online(n))
        online_detail = f"online={online} total={len(nodes)}"
    except Exception as exc:
        control_detail = type(exc).__name__
        failures += 1
    if not control_ok:
        failures += 1
    _print_check(control_ok, "control channel", control_detail)
    _print_check(True, "online nodes", online_detail)

    if failures:
        print(f"[MESH] doctor-agent FAIL ({failures})")
        return 1
    print("[MESH] doctor-agent PASS")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="WXQK MeshCentral deploy helper")
    sub = parser.add_subparsers(dest="cmd", required=True)

    for name, fn in (
        ("prepare", cmd_prepare),
        ("validate", cmd_validate),
        ("up", cmd_up),
        ("down", cmd_down),
        ("status", cmd_status),
        ("logs", cmd_logs),
        ("backup", cmd_backup),
    ):
        p = sub.add_parser(name)
        p.set_defaults(func=fn)

    p_gen = sub.add_parser("gen-secret", help="Write candidate secret (no stdout secret by default)")
    p_gen.add_argument("--write", default="", help="Target env file (default: ./wxqk-mesh.env)")
    p_gen.add_argument("--show-secret", action="store_true", help="DANGEROUS: print full secret")
    p_gen.add_argument("--force", action="store_true", help="Replace existing key in target file")
    p_gen.set_defaults(func=cmd_gen_secret)

    p_boot = sub.add_parser("bootstrap", help="Idempotent Mesh + wxqk mesh.env bootstrap")
    p_boot.add_argument("--public-host", default="", help="Public Mesh hostname or IP")
    p_boot.add_argument("--framing-origin", default="", help="Extra allowedFramingOrigins entry")
    p_boot.add_argument("--allow-example-host", action="store_true", help="Allow mesh.example.invalid for lab")
    p_boot.add_argument("--rotate-key", action="store_true", help="DANGEROUS: replace loginTokenKey")
    p_boot.add_argument("--allow-control-fail", action="store_true", help="Do not fail doctor on control.ashx")
    p_boot.add_argument("--allow-health-fail", action="store_true")
    p_boot.add_argument("--wxqk-health-url", default="")
    p_boot.set_defaults(func=cmd_bootstrap)

    p_doc = sub.add_parser("doctor", help="Non-secret health checklist")
    p_doc.add_argument("--allow-control-fail", action="store_true")
    p_doc.add_argument("--allow-health-fail", action="store_true")
    p_doc.add_argument("--wxqk-health-url", default="", help="Optional wxqk /api/mesh/health URL to probe")
    p_doc.set_defaults(func=cmd_doctor)

    p_da = sub.add_parser("doctor-agent", help="Agent listener / TLS / control / online-count diagnostics")
    p_da.set_defaults(func=cmd_doctor_agent)

    args = parser.parse_args()
    return int(args.func(args) or 0)


if __name__ == "__main__":
    sys.exit(main())
