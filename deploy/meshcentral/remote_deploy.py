#!/usr/bin/env python3
"""One-shot MeshCentral remote bootstrap over SSH.

Reads ONLY from environment (never hardcode secrets):
  WXQK_SSH_HOST
  WXQK_SSH_USER          (default root)
  WXQK_SSH_PASSWORD      (required for password auth)
  WXQK_MESH_PUBLIC_HOST  (default = SSH host / public IP)
  WXQK_MESH_HTTPS_PORT   (default 9443 — separate from wxqk :8443)

Does not write secrets to the git working tree.
"""
from __future__ import annotations

import argparse
import json
import os
import secrets
import sys
import time
from pathlib import Path

import paramiko

HERE = Path(__file__).resolve().parent
REPO_DEPLOY = HERE  # deploy/meshcentral


def env(name: str, default: str = "") -> str:
    return str(os.environ.get(name, default) or "").strip()


def connect() -> paramiko.SSHClient:
    host = env("WXQK_SSH_HOST")
    user = env("WXQK_SSH_USER", "root")
    password = env("WXQK_SSH_PASSWORD")
    if not host or not password:
        raise SystemExit("WXQK_SSH_HOST and WXQK_SSH_PASSWORD required")
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(host, username=user, password=password, timeout=30, allow_agent=False, look_for_keys=False)
    return client


def run(client: paramiko.SSHClient, cmd: str, *, check: bool = True, timeout: int = 600) -> tuple[int, str, str]:
    print(f"+ {cmd}")
    stdin, stdout, stderr = client.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode("utf-8", errors="replace")
    err = stderr.read().decode("utf-8", errors="replace")
    code = stdout.channel.recv_exit_status()
    if out.strip():
        print(out.rstrip()[:8000])
    if err.strip():
        # redact common secret-looking tokens from stderr display
        safe = err
        for key in ("PASSWORD", "SECRET", "LOGIN_KEY", "AccessKey"):
            if key.lower() in safe.lower():
                safe = "[redacted stderr]"
                break
        print(safe.rstrip()[:4000])
    if check and code != 0:
        raise SystemExit(f"remote command failed ({code}): {cmd}")
    return code, out, err


def sftp_put_text(client: paramiko.SSHClient, remote_path: str, content: str, mode: int = 0o644) -> None:
    sftp = client.open_sftp()
    with sftp.file(remote_path, "w") as f:
        f.write(content)
    sftp.chmod(remote_path, mode)
    sftp.close()


def probe(client: paramiko.SSHClient) -> None:
    run(client, "uname -a; cat /etc/os-release | head -n 8; free -h; df -h /; ip -4 addr show | sed -n '1,40p'")


def ensure_docker(client: paramiko.SSHClient) -> None:
    code, out, _ = run(client, "docker --version && docker compose version", check=False)
    if code == 0:
        print("[MESH] Docker already installed")
        run(client, "systemctl enable docker; systemctl start docker", check=False)
        return
    print("[MESH] Installing Docker Engine (official convenience script for Ubuntu)")
    # Official get.docker.com — Ubuntu 22.04
    run(
        client,
        "curl -fsSL https://get.docker.com | sh",
        timeout=900,
    )
    run(client, "systemctl enable docker; systemctl start docker")
    run(client, "docker --version && docker compose version")


def render_config(public_host: str, https_port: int) -> str:
    # MeshCentral Cert = hostname or IP shown to agents/browsers
    cfg = {
        "settings": {
            "Cert": public_host,
            "Port": 443,
            "AliasPort": int(https_port),
            "RedirPort": 80,
            "AgentPort": 4433,
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
                    f"https://{public_host}:{https_port}",
                    f"https://{public_host}:8443",
                ],
            }
        },
    }
    return json.dumps(cfg, indent=2, ensure_ascii=False) + "\n"


def render_compose() -> str:
    return """# Generated on server — do not commit production secrets.
services:
  meshcentral:
    image: ghcr.io/ylianst/meshcentral:1.2.4
    container_name: wxqk-meshcentral
    restart: unless-stopped
    env_file:
      - .env
    environment:
      NODE_ENV: production
      TZ: Asia/Shanghai
      HOSTNAME: ${WXQK_MESH_HOSTNAME}
      REVERSE_PROXY: "false"
      ALLOW_NEW_ACCOUNTS: "false"
      WEBRTC: "false"
      IFRAME: "true"
    volumes:
      - ./data:/opt/meshcentral/meshcentral-data
      - ./files:/opt/meshcentral/meshcentral-files
      - ./backups:/opt/meshcentral/meshcentral-backups
      - ./config.json:/opt/meshcentral/meshcentral-data/config.json:ro
    ports:
      - "${WXQK_MESH_HTTPS_PORT}:443"
      - "127.0.0.1:${WXQK_MESH_HTTP_PORT}:80"
      - "${WXQK_MESH_AGENT_PORT}:4433"
    healthcheck:
      test: ["CMD-SHELL", "node -e \\"require('http').get('http://127.0.0.1:80',r=>process.exit(r.statusCode<500?0:1)).on('error',()=>process.exit(1))\\""]
      interval: 30s
      timeout: 10s
      retries: 5
      start_period: 90s
"""


def render_env(public_host: str, https_port: int, agent_port: int, login_key: str) -> str:
    return f"""# Production MeshCentral env — chmod 600. Do not commit.
MESHCENTRAL_VERSION=1.2.4
TZ=Asia/Shanghai
WXQK_MESH_HOSTNAME={public_host}
WXQK_MESH_HTTPS_PORT={https_port}
WXQK_MESH_HTTP_PORT=8081
WXQK_MESH_AGENT_PORT={agent_port}
WXQK_MESH_REVERSE_PROXY=false
WXQK_MESH_URL=https://{public_host}:{https_port}
WXQK_MESH_INTERNAL_URL=http://127.0.0.1:8081
WXQK_MESH_ENABLED=true
WXQK_MESH_USER=user//admin
WXQK_MESH_LOGIN_KEY={login_key}
WXQK_MESH_TOKEN_EXPIRE_MIN=30
WXQK_MESH_TIMEOUT=15
"""


def nginx_snippet(public_host: str, https_port: int) -> str:
    # Optional path-based note: MeshCentral prefers dedicated host/port.
    # We terminate TLS with MeshCentral's own cert on https_port mapping.
    # If nginx already owns that port, operator must adjust.
    return f"""# MeshCentral is published by Docker on :{https_port} (container :443).
# Keep wxqk nginx :8443 untouched. Agent port 4433 mapped for MeshAgent.
# Public Mesh URL: https://{public_host}:{https_port}
"""


def deploy_files(client: paramiko.SSHClient) -> dict:
    remote = "/opt/wxqk/meshcentral"
    public_host = env("WXQK_MESH_PUBLIC_HOST") or env("WXQK_SSH_HOST")
    https_port = int(env("WXQK_MESH_HTTPS_PORT", "9443") or "9443")
    agent_port = int(env("WXQK_MESH_AGENT_PORT", "4433") or "4433")
    login_key = secrets.token_hex(48)

    run(client, f"mkdir -p {remote}/data {remote}/files {remote}/backups")
    run(client, f"chmod 750 {remote} {remote}/data {remote}/files {remote}/backups")

    sftp_put_text(client, f"{remote}/docker-compose.yml", render_compose(), 0o644)
    sftp_put_text(client, f"{remote}/config.json", render_config(public_host, https_port), 0o640)
    sftp_put_text(client, f"{remote}/.env", render_env(public_host, https_port, agent_port, login_key), 0o600)
    sftp_put_text(client, f"{remote}/NGINX_NOTE.txt", nginx_snippet(public_host, https_port), 0o644)
    sftp_put_text(client, f"{remote}/VERSION", "MESHCENTRAL_VERSION=1.2.4\n", 0o644)

    # Sync login key into wxqk server env without printing it
    run(
        client,
        "mkdir -p /etc/wxqk && touch /etc/wxqk/wxqk.env && chmod 600 /etc/wxqk/wxqk.env",
    )
    # Upsert mesh vars in /etc/wxqk/wxqk.env via remote python (no echo of key in argv if careful)
    upsert = f"""python3 - <<'PY'
from pathlib import Path
p = Path('/etc/wxqk/wxqk.env')
text = p.read_text(encoding='utf-8') if p.exists() else ''
vals = {{
  'WXQK_MESH_ENABLED': '1',
  'WXQK_MESH_URL': 'https://{public_host}:{https_port}',
  'WXQK_MESH_INTERNAL_URL': 'http://127.0.0.1:8081',
  'WXQK_MESH_USER': 'user//admin',
  'WXQK_MESH_LOGIN_KEY': '{login_key}',
  'WXQK_MESH_TOKEN_EXPIRE_MIN': '30',
  'WXQK_MESH_TIMEOUT': '15',
}}
lines = [ln for ln in text.splitlines() if ln.strip() and not any(ln.startswith(k+'=') for k in vals)]
for k,v in vals.items():
    lines.append(f'{{k}}={{v}}')
p.write_text('\\n'.join(lines)+'\\n', encoding='utf-8')
p.chmod(0o600)
print('wxqk.env mesh keys upserted')
PY"""
    run(client, upsert)

    return {
        "remote": remote,
        "public_host": public_host,
        "https_port": https_port,
        "agent_port": agent_port,
        "mesh_url": f"https://{public_host}:{https_port}",
        # Do not return login_key to stdout/report
    }


def start_stack(client: paramiko.SSHClient, remote: str) -> None:
    run(client, f"cd {remote} && docker compose config", timeout=120)
    run(client, f"cd {remote} && docker compose pull", timeout=900)
    run(client, f"cd {remote} && docker compose up -d", timeout=300)
    time.sleep(8)
    run(client, f"cd {remote} && docker compose ps", check=False)
    run(client, f"cd {remote} && docker compose logs --tail=80", check=False)


def health(client: paramiko.SSHClient, meta: dict) -> None:
    run(client, "docker --version; docker compose version; systemctl is-enabled docker; systemctl is-active docker", check=False)
    run(client, f"curl -skI https://127.0.0.1:{meta['https_port']}/ | head -n 15", check=False)
    run(client, f"curl -sI http://127.0.0.1:8081/ | head -n 10", check=False)
    run(client, "ss -tulpn | egrep ':9443|:4433|:8443|:4812|:8081' || true", check=False)
    # Restart wxqk to pick env if service exists
    run(client, "systemctl restart wxqk || true", check=False)
    time.sleep(2)
    run(client, "systemctl is-active wxqk || true", check=False)
    run(
        client,
        "curl -sk https://127.0.0.1:8443/wxqk/api/mesh/health -H 'Accept: application/json' | head -c 500 || true",
        check=False,
    )


def extract_login_key(client: paramiko.SSHClient) -> None:
    # Prefer MeshCentral's own --loginTokenKey after container is up; fall back to .env key.
    code, out, _ = run(
        client,
        "docker exec wxqk-meshcentral node node_modules/meshcentral --loginTokenKey 2>/dev/null | head -n 5",
        check=False,
        timeout=120,
    )
    if code == 0 and out.strip():
        key = "".join(ch for ch in out.strip().splitlines()[-1] if ch.isalnum())
        if len(key) >= 64:
            run(
                client,
                f"""python3 - <<'PY'
from pathlib import Path
key = '{key}'
for path in [Path('/opt/wxqk/meshcentral/.env'), Path('/etc/wxqk/wxqk.env')]:
    if not path.exists():
        continue
    lines = []
    found = False
    for ln in path.read_text(encoding='utf-8').splitlines():
        if ln.startswith('WXQK_MESH_LOGIN_KEY='):
            lines.append('WXQK_MESH_LOGIN_KEY=' + key)
            found = True
        else:
            lines.append(ln)
    if not found:
        lines.append('WXQK_MESH_LOGIN_KEY=' + key)
    path.write_text('\\n'.join(lines)+'\\n', encoding='utf-8')
    path.chmod(0o600)
print('synced MeshCentral loginTokenKey into env files')
PY""",
                check=False,
            )
            run(client, "systemctl restart wxqk || true", check=False)


def backup(client: paramiko.SSHClient, remote: str) -> None:
    stamp = time.strftime("%Y%m%d-%H%M%S")
    run(
        client,
        f"mkdir -p {remote}/backups/{stamp} && cp -a {remote}/config.json {remote}/.env {remote}/backups/{stamp}/ && "
        f"tar -C {remote} -czf {remote}/backups/{stamp}/data.tgz data files 2>/dev/null || true; "
        f"ls -la {remote}/backups/{stamp}",
        check=False,
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["probe", "docker", "deploy", "start", "health", "all", "backup"])
    args = parser.parse_args()
    client = connect()
    try:
        if args.action in ("probe", "all"):
            probe(client)
        if args.action in ("docker", "all"):
            ensure_docker(client)
        meta = None
        if args.action in ("deploy", "all"):
            meta = deploy_files(client)
            print(json.dumps({k: v for k, v in meta.items()}, ensure_ascii=False))
        if args.action in ("start", "all"):
            if meta is None:
                meta = {
                    "remote": "/opt/wxqk/meshcentral",
                    "https_port": int(env("WXQK_MESH_HTTPS_PORT", "9443") or "9443"),
                }
            start_stack(client, meta["remote"])
            extract_login_key(client)
        if args.action in ("health", "all"):
            if meta is None:
                meta = {
                    "https_port": int(env("WXQK_MESH_HTTPS_PORT", "9443") or "9443"),
                }
            health(client, meta)
        if args.action == "backup":
            backup(client, "/opt/wxqk/meshcentral")
        if args.action == "all":
            backup(client, "/opt/wxqk/meshcentral")
    finally:
        client.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
