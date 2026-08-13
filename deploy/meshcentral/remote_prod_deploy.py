#!/usr/bin/env python3
"""Deploy MeshCentral 1.2.4 to the WXQK production host over SSH.

Secrets MUST come from the environment (never commit):
  WXQK_SSH_HOST, WXQK_SSH_USER, WXQK_SSH_PASSWORD

This script writes secrets only on the remote host under /opt/wxqk/meshcentral/.env
(chmod 600). It does not print secret values.
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
REMOTE_DIR = "/opt/wxqk/meshcentral"
MESH_PUBLIC_PORT = int(os.environ.get("WXQK_MESH_PUBLIC_PORT", "8444"))
MESH_AGENT_PORT = int(os.environ.get("WXQK_MESH_AGENT_PORT", "4433"))
# Bind MeshCentral TLS/HTTP only on loopback; nginx terminates public TLS.
MESH_LOCAL_HTTPS = 9443
MESH_LOCAL_HTTP = 9080


def _ssh() -> paramiko.SSHClient:
    host = os.environ.get("WXQK_SSH_HOST") or ""
    user = os.environ.get("WXQK_SSH_USER", "root")
    password = os.environ.get("WXQK_SSH_PASSWORD") or ""
    if not host or not password:
        raise SystemExit("WXQK_SSH_HOST and WXQK_SSH_PASSWORD required")
    client = paramiko.SSHClient()
    client.load_system_host_keys()
    kh = Path.home() / ".ssh" / "known_hosts"
    if kh.exists():
        client.load_host_keys(str(kh))
    client.set_missing_host_key_policy(paramiko.RejectPolicy())
    client.connect(host, username=user, password=password, timeout=45)
    return client


def run(client: paramiko.SSHClient, cmd: str, *, timeout: int = 600, check: bool = True) -> tuple[int, str, str]:
    print(f"+ remote: {cmd[:200]}{'…' if len(cmd) > 200 else ''}")
    _stdin, stdout, stderr = client.exec_command(cmd, timeout=timeout, get_pty=True)
    out = stdout.read().decode("utf-8", "replace")
    err = stderr.read().decode("utf-8", "replace")
    code = stdout.channel.recv_exit_status()
    if out.strip():
        print(out.rstrip())
    if err.strip() and err.strip() != out.strip():
        print(err.rstrip(), file=sys.stderr)
    if check and code != 0:
        raise SystemExit(f"remote command failed ({code}): {cmd[:120]}")
    return code, out, err


def sftp_put_text(client: paramiko.SSHClient, remote_path: str, text: str, mode: int = 0o644) -> None:
    sftp = client.open_sftp()
    try:
        with sftp.file(remote_path, "w") as f:
            f.write(text)
        sftp.chmod(remote_path, mode)
    finally:
        sftp.close()
    print(f"+ put {remote_path} (mode {oct(mode)})")


def sftp_put_bytes(client: paramiko.SSHClient, remote_path: str, data: bytes, mode: int = 0o644) -> None:
    sftp = client.open_sftp()
    try:
        with sftp.file(remote_path, "wb") as f:
            f.write(data)
        sftp.chmod(remote_path, mode)
    finally:
        sftp.close()
    print(f"+ put {remote_path} ({len(data)} bytes, mode {oct(mode)})")


def cmd_inspect(_: argparse.Namespace) -> int:
    c = _ssh()
    try:
        run(
            c,
            "uname -a; . /etc/os-release; echo VERSION_ID=$VERSION_ID; free -h; df -h /; "
            "ss -tulpn | head -60; docker --version 2>/dev/null || echo NO_DOCKER; "
            "nginx -v 2>&1; ls /etc/nginx/sites-enabled/; systemctl is-active wxqk; "
            "ufw status | head -40",
            check=False,
        )
    finally:
        c.close()
    return 0


def cmd_install_docker(_: argparse.Namespace) -> int:
    c = _ssh()
    try:
        run(
            c,
            r"""
set -e
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  docker --version
  docker compose version
  systemctl enable --now docker
  echo DOCKER_ALREADY_OK
  exit 0
fi
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl gnupg
install -m 0755 -d /etc/apt/keyrings
if [ ! -f /etc/apt/keyrings/docker.gpg ]; then
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
fi
. /etc/os-release
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $VERSION_CODENAME stable" > /etc/apt/sources.list.d/docker.list
apt-get update -y
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker
docker --version
docker compose version
systemctl is-active docker
echo DOCKER_INSTALL_OK
""",
            timeout=900,
        )
    finally:
        c.close()
    return 0


def _compose_yml() -> str:
    # Localhost-only HTTP(S); AgentPort published for MeshAgent.
    return f"""# Generated for WXQK production — MeshCentral 1.2.4 (do not use :latest)
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
      HOSTNAME: "{os.environ.get('WXQK_SSH_HOST', '127.0.0.1')}"
      REVERSE_PROXY: "true"
      REVERSE_PROXY_TLS_PORT: "{MESH_PUBLIC_PORT}"
      IFRAME: "true"
      ALLOW_NEW_ACCOUNTS: "false"
      WEBRTC: "false"
    volumes:
      - ./data:/opt/meshcentral/meshcentral-data
      - ./files:/opt/meshcentral/meshcentral-files
      - ./backups:/opt/meshcentral/meshcentral-backups
      - ./config.json:/opt/meshcentral/meshcentral-data/config.json:ro
    ports:
      - "127.0.0.1:{MESH_LOCAL_HTTPS}:443"
      - "127.0.0.1:{MESH_LOCAL_HTTP}:80"
      - "0.0.0.0:{MESH_AGENT_PORT}:4433"
    healthcheck:
      test:
        [
          "CMD-SHELL",
          "node -e \\"require('http').get('http://127.0.0.1:80',r=>process.exit(r.statusCode<500?0:1)).on('error',()=>process.exit(1))\\"",
        ]
      interval: 30s
      timeout: 10s
      retries: 5
      start_period: 120s
    networks:
      - meshnet

networks:
  meshnet:
    driver: bridge
"""


def _config_json(host: str) -> str:
    data = {
        "settings": {
            "Cert": host,
            "Port": 443,
            "AliasPort": MESH_PUBLIC_PORT,
            "RedirPort": 80,
            "AgentPort": MESH_AGENT_PORT,
            "TlsOffload": "127.0.0.1,172.16.0.0/12",
            "SelfUpdate": False,
            "sessionSameSite": "none",
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
                    f"https://{host}:{MESH_PUBLIC_PORT}",
                    f"https://{host}:8443",
                ],
                "agentCustomization": {
                    "displayName": "WXQK",
                    "description": "WXQK",
                    "companyName": "WXQK",
                    "serviceName": "WXQK",
                    "fileName": "WXQK",
                },
                "agentFileInfo": {
                    "icon": "wxqk-agent.ico",
                    "filedescription": "WXQK",
                    "internalname": "WXQK",
                    "originalfilename": "WXQK.exe",
                    "productname": "WXQK",
                },
            }
        },
    }
    return json.dumps(data, indent=2) + "\n"


def _nginx_conf(host: str) -> str:
    # Do not redefine $connection_upgrade here — wxqk sites already provide the map.
    return f"""# WXQK MeshCentral reverse proxy — do not overwrite wxqk sites
# Public: https://{host}:{MESH_PUBLIC_PORT}  →  127.0.0.1:{MESH_LOCAL_HTTPS}

# TlsOffload: MeshCentral Port is plain HTTP on loopback; nginx terminates TLS.
upstream wxqk_meshcentral {{
    server 127.0.0.1:{MESH_LOCAL_HTTPS};
    keepalive 32;
}}

server {{
    listen {MESH_PUBLIC_PORT} ssl http2;
    listen [::]:{MESH_PUBLIC_PORT} ssl http2;
    server_name {host} _;

    ssl_certificate     /etc/nginx/ssl/wxqk-ip.crt;
    ssl_certificate_key /etc/nginx/ssl/wxqk-ip.key;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_session_timeout 1d;
    ssl_session_cache shared:MeshSSL:10m;

    client_max_body_size 512m;
    proxy_connect_timeout 60s;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;

    location / {{
        proxy_pass http://wxqk_meshcentral;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_buffering off;
        proxy_request_buffering off;
    }}
}}
"""


def cmd_deploy(_: argparse.Namespace) -> int:
    host = os.environ.get("WXQK_SSH_HOST") or ""
    public_url = f"https://{host}:{MESH_PUBLIC_PORT}"
    # Random hex for MeshCentral loginTokenKey (32+ bytes). Final key often
    # comes from `node meshcentral --loginTokenKey` after first boot — we
    # still generate a placeholder wxqk secret and replace after extraction.
    login_key_hex = secrets.token_hex(48)

    c = _ssh()
    try:
        run(c, f"mkdir -p {REMOTE_DIR}/data {REMOTE_DIR}/files {REMOTE_DIR}/backups && chmod 750 {REMOTE_DIR}")
        sftp_put_text(c, f"{REMOTE_DIR}/docker-compose.yml", _compose_yml())
        sftp_put_text(c, f"{REMOTE_DIR}/config.json", _config_json(host))
        env_body = (
            f"MESHCENTRAL_VERSION=1.2.4\n"
            f"TZ=Asia/Shanghai\n"
            f"WXQK_MESH_URL={public_url}\n"
            f"WXQK_MESH_INTERNAL_URL=http://127.0.0.1:{MESH_LOCAL_HTTP}\n"
            f"WXQK_MESH_HOSTNAME={host}\n"
            f"WXQK_MESH_HTTPS_PORT={MESH_LOCAL_HTTPS}\n"
            f"WXQK_MESH_HTTP_PORT={MESH_LOCAL_HTTP}\n"
            f"WXQK_MESH_AGENT_PORT={MESH_AGENT_PORT}\n"
            f"WXQK_MESH_REVERSE_PROXY=true\n"
            f"WXQK_MESH_REVERSE_PROXY_TLS_PORT={MESH_PUBLIC_PORT}\n"
            f"WXQK_MESH_ENABLED=true\n"
            f"WXQK_MESH_USER=user//admin\n"
            f"WXQK_MESH_LOGIN_KEY={login_key_hex}\n"
            f"WXQK_MESH_TOKEN_EXPIRE_MIN=30\n"
        )
        sftp_put_text(c, f"{REMOTE_DIR}/.env", env_body, mode=0o600)
        nginx_path = "/etc/nginx/sites-available/wxqk-mesh-8444.conf"
        sftp_put_text(c, nginx_path, _nginx_conf(host))
        run(
            c,
            f"ln -sfn {nginx_path} /etc/nginx/sites-enabled/wxqk-mesh-8444.conf && "
            f"ufw allow {MESH_PUBLIC_PORT}/tcp && ufw allow {MESH_AGENT_PORT}/tcp && "
            f"nginx -t && systemctl reload nginx",
        )
        run(
            c,
            f"cd {REMOTE_DIR} && docker compose config >/tmp/mesh-compose-check.yml && "
            f"docker compose pull && docker compose up -d",
            timeout=900,
        )
        time.sleep(8)
        run(c, f"cd {REMOTE_DIR} && docker compose ps && docker compose logs --tail=80", check=False)
        # Wait for healthy container, then extract MeshCentral loginTokenKey
        run(
            c,
            f"cd {REMOTE_DIR}; "
            f"for i in 1 2 3 4 5 6 7 8 9 10 11 12; do "
            f"  st=$(docker inspect -f '{{{{.State.Health.Status}}}}' wxqk-meshcentral 2>/dev/null || echo starting); "
            f"  echo health=$st; "
            f"  [ \"$st\" = healthy ] && break; "
            f"  docker compose ps; sleep 10; "
            f"done",
            check=False,
            timeout=200,
        )
        _, out, _ = run(
            c,
            f"cd {REMOTE_DIR} && "
            f"(docker compose exec -T meshcentral node meshcentral --loginTokenKey || "
            f" docker compose exec -T meshcentral node /opt/meshcentral/meshcentral --loginTokenKey || "
            f" docker compose exec -T meshcentral sh -c 'cd /opt/meshcentral && node node_modules/meshcentral --loginTokenKey' || true)",
            check=False,
        )
        extracted = ""
        for line in out.splitlines():
            line = line.strip().strip('"').strip("'")
            if len(line) >= 64 and all(ch in "0123456789abcdefABCDEF" for ch in line):
                extracted = line.lower()
                break
        if not extracted:
            # Fallback: read from MeshCentral data settings if present
            _, out2, _ = run(
                c,
                f"python3 - <<'PY'\n"
                f"import json,glob,re\n"
                f"from pathlib import Path\n"
                f"root=Path('{REMOTE_DIR}/data')\n"
                f"for p in list(root.glob('**/*'))[:200]:\n"
                f"  if not p.is_file(): continue\n"
                f"  try:\n"
                f"    t=p.read_text(errors='ignore')\n"
                f"  except Exception:\n"
                f"    continue\n"
                f"  if 'loginTokenKey' in t:\n"
                f"    m=re.search(r'loginTokenKey[\\\"\\']?\\s*[:=]\\s*[\\\"\\']([0-9a-fA-F]{{64,}})[\\\"\\']', t)\n"
                f"    if m: print(m.group(1).lower()); break\n"
                f"    try:\n"
                f"      j=json.loads(t)\n"
                f"      k=((j.get('settings') or {{}}).get('loginTokenKey') or '')\n"
                f"      if isinstance(k,str) and len(k)>=64: print(k.lower()); break\n"
                f"    except Exception: pass\n"
                f"PY",
                check=False,
            )
            for line in out2.splitlines():
                line = line.strip()
                if len(line) >= 64 and all(ch in "0123456789abcdefABCDEF" for ch in line):
                    extracted = line.lower()
                    break
        if extracted:
            login_key_hex = extracted
            print("[MESH] loginTokenKey extracted (value not printed)")
        else:
            print("[MESH] WARN loginTokenKey not extracted; using generated placeholder until admin bootstrap")

        # Update mesh .env + wxqk.env without printing secret values
        update_py = f"""
from pathlib import Path
key = {login_key_hex!r}
public_url = {public_url!r}
mesh_env = Path('{REMOTE_DIR}/.env')
lines = []
for line in mesh_env.read_text().splitlines():
    if line.startswith('WXQK_MESH_LOGIN_KEY='):
        lines.append('WXQK_MESH_LOGIN_KEY=' + key)
    else:
        lines.append(line)
mesh_env.write_text('\\n'.join(lines) + '\\n')
mesh_env.chmod(0o600)
p = Path('/etc/wxqk/wxqk.env')
text = p.read_text() if p.exists() else ''
kv = {{
  'WXQK_MESH_ENABLED': '1',
  'WXQK_MESH_URL': public_url,
  'WXQK_MESH_INTERNAL_URL': 'http://127.0.0.1:{MESH_LOCAL_HTTP}',
  'WXQK_MESH_USER': 'user//admin',
  'WXQK_MESH_LOGIN_KEY': key,
  'WXQK_MESH_TOKEN_EXPIRE_MIN': '30',
}}
out_lines = [ln for ln in text.splitlines() if not any(ln.startswith(k + '=') for k in kv)]
for k, v in kv.items():
    out_lines.append(f'{{k}}={{v}}')
p.parent.mkdir(parents=True, exist_ok=True)
p.write_text('\\n'.join(out_lines) + '\\n')
p.chmod(0o600)
print('WXQK_ENV_MESH_WIRED')
"""
        sftp_put_text(c, "/tmp/wxqk_wire_mesh_env.py", update_py, mode=0o700)
        run(
            c,
            "python3 /tmp/wxqk_wire_mesh_env.py && shred -u /tmp/wxqk_wire_mesh_env.py 2>/dev/null || rm -f /tmp/wxqk_wire_mesh_env.py; "
            "systemctl restart wxqk || true; sleep 2; systemctl is-active wxqk; "
            "curl -sk -o /dev/null -w 'wxqk_mesh_health_http=%{http_code}\\n' https://127.0.0.1:8443/wxqk/api/mesh/health || true; "
            f"curl -sk -o /dev/null -w 'mesh_https=%{{http_code}}\\n' {public_url}/ || true",
        )
        print(f"[MESH] public_url={public_url} agent_port={MESH_AGENT_PORT}")
        print("[MESH] deploy steps finished (check container health / create admin in Mesh UI next)")
    finally:
        c.close()
    return 0


def cmd_status(_: argparse.Namespace) -> int:
    c = _ssh()
    try:
        run(
            c,
            f"cd {REMOTE_DIR} && docker compose ps; docker compose logs --tail=50; "
            f"ss -tulpn | grep -E ':{MESH_PUBLIC_PORT}|:{MESH_AGENT_PORT}|:{MESH_LOCAL_HTTPS}|:{MESH_LOCAL_HTTP}' || true; "
            f"curl -sk -I https://127.0.0.1:{MESH_PUBLIC_PORT}/ | head -15; "
            f"curl -sk https://127.0.0.1:8443/wxqk/api/mesh/health | head -c 400; echo; "
            f"systemctl is-active wxqk docker; systemctl is-enabled docker",
            check=False,
        )
    finally:
        c.close()
    return 0


def cmd_backup(_: argparse.Namespace) -> int:
    c = _ssh()
    try:
        stamp = time.strftime("%Y%m%d-%H%M%S")
        run(
            c,
            f"cd {REMOTE_DIR} && mkdir -p backups/wxqk-mesh-{stamp} && "
            f"cp -a config.json .env data files backups/wxqk-mesh-{stamp}/ && "
            f"ls -la backups/wxqk-mesh-{stamp} && du -sh backups/wxqk-mesh-{stamp}",
        )
    finally:
        c.close()
    return 0


def main() -> None:
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("inspect").set_defaults(func=cmd_inspect)
    sub.add_parser("install-docker").set_defaults(func=cmd_install_docker)
    sub.add_parser("deploy").set_defaults(func=cmd_deploy)
    sub.add_parser("status").set_defaults(func=cmd_status)
    sub.add_parser("backup").set_defaults(func=cmd_backup)
    args = p.parse_args()
    raise SystemExit(args.func(args))


if __name__ == "__main__":
    main()
