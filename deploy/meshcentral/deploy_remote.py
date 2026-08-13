#!/usr/bin/env python3
"""Remote MeshCentral deploy helper for WXQK.

Reads ONLY from environment (never hardcode secrets):
  WXQK_SSH_HOST
  WXQK_SSH_USER          (default root)
  WXQK_SSH_PASSWORD      (optional; agent keys also OK)
  WXQK_MESH_PUBLIC_HOST  (default = SSH host IP)
  WXQK_MESH_HTTPS_PORT   (default 8444 — avoid clashing with wxqk :8443)

Does not print passwords / AccessKeys / loginTokenKey.
Does not write secrets into the git working tree.
"""
from __future__ import annotations

import argparse
import os
import secrets
import sys
import time
from pathlib import Path

import paramiko

HERE = Path(__file__).resolve().parent
REPO_DEPLOY = HERE
REMOTE_DIR = "/opt/wxqk/meshcentral"
HOST = os.environ.get("WXQK_SSH_HOST", "").strip()
USER = os.environ.get("WXQK_SSH_USER", "root").strip()
PASSWORD = os.environ.get("WXQK_SSH_PASSWORD") or None
PUBLIC_HOST = os.environ.get("WXQK_MESH_PUBLIC_HOST", "").strip() or HOST
HTTPS_PORT = int(os.environ.get("WXQK_MESH_HTTPS_PORT", "8444") or "8444")
AGENT_PORT = int(os.environ.get("WXQK_MESH_AGENT_PORT", "4433") or "4433")
HTTP_PORT = int(os.environ.get("WXQK_MESH_HTTP_PORT", "8088") or "8088")


def connect() -> paramiko.SSHClient:
    if not HOST:
        raise SystemExit("WXQK_SSH_HOST required")
    c = paramiko.SSHClient()
    c.load_system_host_keys()
    kh = Path.home() / ".ssh" / "known_hosts"
    if kh.exists():
        c.load_host_keys(str(kh))
    c.set_missing_host_key_policy(paramiko.RejectPolicy())
    c.connect(
        HOST,
        username=USER,
        password=PASSWORD,
        timeout=30,
        allow_agent=PASSWORD is None,
        look_for_keys=PASSWORD is None,
    )
    return c


def run(c: paramiko.SSHClient, cmd: str, *, check: bool = True, timeout: int = 600) -> tuple[int, str, str]:
    print(f"+ {cmd}")
    stdin, stdout, stderr = c.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode("utf-8", errors="replace")
    err = stderr.read().decode("utf-8", errors="replace")
    code = stdout.channel.recv_exit_status()
    if out.strip():
        print(out.rstrip())
    if err.strip():
        # Avoid dumping secrets if any ever appear
        safe = err
        for needle in filter(None, [PASSWORD]):
            safe = safe.replace(needle, "***")
        print(safe.rstrip(), file=sys.stderr)
    if check and code != 0:
        raise RuntimeError(f"remote exit {code}: {cmd}")
    return code, out, err


def sftp_put_dir(c: paramiko.SSHClient, local: Path, remote: str, names: list[str]) -> None:
    sftp = c.open_sftp()
    try:
        run(c, f"mkdir -p {remote}/data {remote}/files {remote}/backups", check=True)
        for name in names:
            src = local / name
            if not src.exists():
                raise FileNotFoundError(src)
            dst = f"{remote}/{name}"
            print(f"+ upload {name} -> {dst}")
            sftp.put(str(src), dst)
    finally:
        sftp.close()


def cmd_probe(_: argparse.Namespace) -> int:
    c = connect()
    try:
        run(c, "uname -a; cat /etc/os-release | head -n 8; free -h; df -h /; nproc")
        run(c, "command -v docker >/dev/null && docker --version || echo 'DOCKER_MISSING'")
        run(c, "command -v docker >/dev/null && docker compose version || true", check=False)
        run(c, "ss -tulpn | head -n 80 || netstat -tulpn | head -n 80", check=False)
        run(c, "systemctl is-active nginx 2>/dev/null || true; ls /etc/nginx/sites-enabled 2>/dev/null || true", check=False)
        run(c, "systemctl is-active wxqk 2>/dev/null || true; ls /opt/wxqk 2>/dev/null | head", check=False)
    finally:
        c.close()
    return 0


def cmd_install_docker(_: argparse.Namespace) -> int:
    c = connect()
    try:
        code, out, _ = run(c, "command -v docker >/dev/null && echo HAS_DOCKER || echo NO_DOCKER", check=False)
        if "HAS_DOCKER" in out:
            run(c, "docker --version; docker compose version; systemctl enable --now docker")
            return 0
        # Official convenience script for Ubuntu Engine (server)
        script = r"""
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl gnupg
install -m 0755 -d /etc/apt/keyrings
if [ ! -f /etc/apt/keyrings/docker.asc ]; then
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
fi
. /etc/os-release
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $VERSION_CODENAME stable" > /etc/apt/sources.list.d/docker.list
apt-get update -y
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker
docker --version
docker compose version
"""
        run(c, "bash -lc " + repr(script))
    finally:
        c.close()
    return 0


def _prod_config(public_host: str) -> str:
    # Framing origins: Electron file/app + localhost dev; production uses top-level BrowserWindow
    # so framing is less critical, but keep allowFraming for future iframe.
    import json

    cfg = {
        "settings": {
            "Cert": public_host,
            "Port": 443,
            "AliasPort": HTTPS_PORT,
            "RedirPort": 80,
            "AgentPort": AGENT_PORT,
            "TlsOffload": False,
            "SelfUpdate": False,
            "sessionSameSite": "lax",
            "webRTC": False,
            "allowFraming": True,
            "allowLoginToken": True,
            "agentPing": 30,
            "agentIdleTimeout": 150,
            "WANonly": True,
            "minify": True,
            "NewAccounts": False,
            "MaxInvalidLogin": {"time": 10, "count": 10, "coolofftime": 10},
        },
        "domains": {
            "": {
                "title": "WXQK Remote",
                "title2": "Remote Maintenance",
                "newAccounts": False,
                "userSessionIdleTimeout": 60,
                "allowedFramingOrigins": [
                    "http://localhost:5173",
                    "file://",
                    "app://.",
                ],
            }
        },
    }
    return json.dumps(cfg, indent=2) + "\n"


def _prod_env(public_host: str) -> str:
    return f"""MESHCENTRAL_VERSION=1.2.4
TZ=Asia/Shanghai
WXQK_MESH_HOSTNAME={public_host}
WXQK_MESH_HTTPS_PORT={HTTPS_PORT}
WXQK_MESH_HTTP_PORT={HTTP_PORT}
WXQK_MESH_AGENT_PORT={AGENT_PORT}
WXQK_MESH_REVERSE_PROXY=false
WXQK_MESH_REVERSE_PROXY_TLS_PORT={HTTPS_PORT}
WXQK_MESH_URL=https://{public_host}:{HTTPS_PORT}
WXQK_MESH_INTERNAL_URL=http://127.0.0.1:{HTTP_PORT}
WXQK_MESH_ENABLED=false
"""


def _prod_compose() -> str:
    # Bind web to localhost+dedicated public HTTPS port; expose agent port for MeshAgent.
    return f"""services:
  meshcentral:
    image: ghcr.io/ylianst/meshcentral:1.2.4
    container_name: wxqk-meshcentral
    restart: unless-stopped
    env_file:
      - .env
    environment:
      NODE_ENV: production
      TZ: ${{TZ:-Asia/Shanghai}}
      HOSTNAME: ${{WXQK_MESH_HOSTNAME}}
      REVERSE_PROXY: "false"
      IFRAME: "true"
      ALLOW_NEW_ACCOUNTS: "false"
      WEBRTC: "false"
    volumes:
      - ./data:/opt/meshcentral/meshcentral-data
      - ./files:/opt/meshcentral/meshcentral-files
      - ./backups:/opt/meshcentral/meshcentral-backups
      - ./config.json:/opt/meshcentral/meshcentral-data/config.json:ro
    ports:
      - "127.0.0.1:{HTTP_PORT}:80"
      - "{HTTPS_PORT}:443"
      - "{AGENT_PORT}:4433"
    healthcheck:
      test:
        [
          "CMD-SHELL",
          "node -e \\"require('http').get('http://127.0.0.1:80',r=>process.exit(r.statusCode<500?0:1)).on('error',()=>process.exit(1))\\"",
        ]
      interval: 30s
      timeout: 10s
      retries: 5
      start_period: 90s
"""


def cmd_deploy(_: argparse.Namespace) -> int:
    c = connect()
    try:
        run(c, f"mkdir -p {REMOTE_DIR}/data {REMOTE_DIR}/files {REMOTE_DIR}/backups")
        # Upload pinned compose pieces from repo as templates, then overwrite production compose/env/config.
        sftp_put_dir(
            c,
            REPO_DEPLOY,
            REMOTE_DIR,
            ["VERSION", "nginx.example.conf", "manage.py", "check-mesh-relay.ps1", "README.md"],
        )
        sftp = c.open_sftp()
        try:
            print("+ write production docker-compose.yml / config.json / .env (no echo of secrets)")
            with sftp.file(f"{REMOTE_DIR}/docker-compose.yml", "w") as f:
                f.write(_prod_compose())
            with sftp.file(f"{REMOTE_DIR}/config.json", "w") as f:
                f.write(_prod_config(PUBLIC_HOST))
            with sftp.file(f"{REMOTE_DIR}/.env", "w") as f:
                f.write(_prod_env(PUBLIC_HOST))
        finally:
            sftp.close()
        run(c, f"chmod 600 {REMOTE_DIR}/.env {REMOTE_DIR}/config.json")
        run(c, f"chmod 700 {REMOTE_DIR}/data {REMOTE_DIR}/files {REMOTE_DIR}/backups")
        run(c, f"cd {REMOTE_DIR} && docker compose config >/dev/null")
        run(c, f"cd {REMOTE_DIR} && docker compose pull", timeout=900)
        run(c, f"cd {REMOTE_DIR} && docker compose up -d", timeout=300)
        time.sleep(8)
        run(c, f"cd {REMOTE_DIR} && docker compose ps")
        run(c, f"cd {REMOTE_DIR} && docker compose logs --tail=80", check=False)
        # Generate / show loginTokenKey inside container (print only on remote stdout once)
        run(
            c,
            f"cd {REMOTE_DIR} && docker compose exec -T meshcentral "
            f"node /opt/meshcentral/node_modules/meshcentral --loginTokenKey 2>/dev/null | head -n 5 || "
            f"docker compose exec -T meshcentral node node_modules/meshcentral --loginTokenKey 2>/dev/null | head -n 5 || true",
            check=False,
        )
        print("[MESH] deploy finished")
        print(f"[MESH] public URL (no secret): https://{PUBLIC_HOST}:{HTTPS_PORT}")
        print(f"[MESH] agent port: {AGENT_PORT}")
    finally:
        c.close()
    return 0


def cmd_status(_: argparse.Namespace) -> int:
    c = connect()
    try:
        run(c, f"cd {REMOTE_DIR} && docker compose ps", check=False)
        run(c, f"curl -skI https://127.0.0.1:{HTTPS_PORT}/ | head -n 15", check=False)
        run(c, f"curl -sI http://127.0.0.1:{HTTP_PORT}/ | head -n 10", check=False)
        run(c, f"cd {REMOTE_DIR} && docker compose logs --tail=40", check=False)
    finally:
        c.close()
    return 0


def cmd_backup(_: argparse.Namespace) -> int:
    c = connect()
    try:
        stamp = time.strftime("%Y%m%d-%H%M%S")
        run(
            c,
            f"cd {REMOTE_DIR} && mkdir -p backups && "
            f"tar -czf backups/mesh-backup-{stamp}.tgz --exclude=backups data files config.json .env && "
            f"ls -lh backups/mesh-backup-{stamp}.tgz && chmod 600 backups/mesh-backup-{stamp}.tgz",
        )
    finally:
        c.close()
    return 0


def main() -> int:
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    for name, fn in (
        ("probe", cmd_probe),
        ("install-docker", cmd_install_docker),
        ("deploy", cmd_deploy),
        ("status", cmd_status),
        ("backup", cmd_backup),
    ):
        sp = sub.add_parser(name)
        sp.set_defaults(func=fn)
    args = p.parse_args()
    return int(args.func(args) or 0)


if __name__ == "__main__":
    sys.exit(main())
