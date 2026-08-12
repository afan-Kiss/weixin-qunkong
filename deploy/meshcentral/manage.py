#!/usr/bin/env python3
"""MeshCentral deploy helper for WXQK (no secrets committed).

Usage (from repo root or this directory):
  python manage.py prepare
  python manage.py validate
  python manage.py up
  python manage.py down
  python manage.py status
  python manage.py logs
  python manage.py backup
  python manage.py gen-secret

Requires Docker Compose on the host. Does not invent MeshCentral REST APIs.
"""
from __future__ import annotations

import argparse
import json
import os
import secrets
import shutil
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
VERSION_FILE = HERE / "VERSION"
COMPOSE = HERE / "docker-compose.yml"
ENV_EXAMPLE = HERE / ".env.example"
CFG_EXAMPLE = HERE / "config.example.json"


def _run(cmd: list[str], *, check: bool = True) -> int:
    print("+", " ".join(cmd))
    return subprocess.run(cmd, cwd=str(HERE), check=check).returncode


def _docker_available() -> bool:
    return shutil.which("docker") is not None


def cmd_prepare(_: argparse.Namespace) -> int:
    env_path = HERE / ".env"
    cfg_path = HERE / "config.json"
    if not env_path.exists():
        shutil.copyfile(ENV_EXAMPLE, env_path)
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


def cmd_validate(_: argparse.Namespace) -> int:
    errors: list[str] = []
    if not COMPOSE.exists():
        errors.append("docker-compose.yml missing")
    if not VERSION_FILE.exists():
        errors.append("VERSION missing")
    pinned = ""
    try:
        for line in VERSION_FILE.read_text(encoding="utf-8").splitlines():
            if line.strip().startswith("MESHCENTRAL_VERSION="):
                pinned = line.split("=", 1)[1].strip()
                break
    except Exception as exc:
        errors.append(f"VERSION read error: {exc}")
    if pinned != "1.2.4":
        errors.append(f"VERSION must pin MESHCENTRAL_VERSION=1.2.4 (got {pinned or 'empty'})")
    cfg = HERE / "config.json"
    target = cfg if cfg.exists() else CFG_EXAMPLE
    try:
        data = json.loads(target.read_text(encoding="utf-8"))
        settings = data.get("settings") or {}
        if settings.get("webRTC") is not False:
            errors.append(f"{target.name}: settings.webRTC must be false")
        if settings.get("allowLoginToken") is not True:
            errors.append(f"{target.name}: settings.allowLoginToken must be true")
    except Exception as exc:
        errors.append(f"config parse error: {exc}")
    text = COMPOSE.read_text(encoding="utf-8")
    if ":latest" in text.replace("${MESHCENTRAL_VERSION:-1.2.4}", "PINNED"):
        # allow only as documentation elsewhere; image line must not be bare :latest
        pass
    if "meshcentral:latest" in text or "meshcentral:${MESHCENTRAL_VERSION:-latest}" in text:
        errors.append("compose must not use :latest")
    if "1.2.4" not in text:
        errors.append("compose default image tag must include 1.2.4")
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
    return _run(["docker", "compose", "up", "-d"])


def cmd_down(_: argparse.Namespace) -> int:
    if not _docker_available():
        print("[MESH] docker not available")
        return 2
    return _run(["docker", "compose", "down"])


def cmd_status(_: argparse.Namespace) -> int:
    if not _docker_available():
        print("[MESH] docker not available")
        return 2
    return _run(["docker", "compose", "ps"], check=False)


def cmd_logs(_: argparse.Namespace) -> int:
    if not _docker_available():
        print("[MESH] docker not available")
        return 2
    return _run(["docker", "compose", "logs", "--tail", "200"], check=False)


def cmd_backup(_: argparse.Namespace) -> int:
    stamp = time.strftime("%Y%m%d-%H%M%S")
    dest = HERE / "backups" / f"wxqk-mesh-{stamp}"
    dest.mkdir(parents=True, exist_ok=True)
    for name in ("data", "files", "config.json", ".env"):
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


def cmd_gen_secret(_: argparse.Namespace) -> int:
    # MeshCentral loginTokenKey is typically long hex (>= 80 bytes displayed as hex)
    key = secrets.token_hex(48)
    print("# Paste into wxqk host env (not git):")
    print(f"WXQK_MESH_LOGIN_KEY={key}")
    print("# On MeshCentral host, prefer: node node_modules/meshcentral --loginTokenKey")
    print("# The value above is a random candidate if you will set the server key yourself.")
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
        ("gen-secret", cmd_gen_secret),
    ):
        p = sub.add_parser(name)
        p.set_defaults(func=fn)
    args = parser.parse_args()
    return int(args.func(args) or 0)


if __name__ == "__main__":
    sys.exit(main())
