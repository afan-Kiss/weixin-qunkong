#!/usr/bin/env python3
"""Deploy self-hosted LiveKit on the wxqk host and wire env for wxqk.

Single-node docker (host network). Agents use ws://HOST:7880.
Browsers on the wall use wss://xiangyuzhubao.xyz:7882 (TLS proxy on portal host).

Usage:
  set WXQK_SSH_HOST / WXQK_SSH_PASSWORD
  optionally RD_PORTAL_SSH_HOST / RD_PORTAL_SSH_PASSWORD for browser TLS proxy
  py -3 deploy_livekit.py
"""
from __future__ import annotations

import os
import secrets
import time
from pathlib import Path

import paramiko

HOST = os.environ.get("WXQK_SSH_HOST", "120.27.219.138").strip()
USER = os.environ.get("WXQK_SSH_USER", "root")
PASSWORD = os.environ.get("WXQK_SSH_PASSWORD") or "FFff472336362@@"
PORTAL_HOST = os.environ.get("RD_PORTAL_SSH_HOST", "47.108.21.50").strip()
PORTAL_PASS = os.environ.get("RD_PORTAL_SSH_PASSWORD") or PASSWORD
API_KEY = (os.environ.get("WXQK_LIVEKIT_API_KEY") or "wxqk").strip()
API_SECRET = (os.environ.get("WXQK_LIVEKIT_API_SECRET") or "").strip()
PUBLIC_IP = (os.environ.get("WXQK_LIVEKIT_NODE_IP") or HOST).strip()
ENV_FILE = "/etc/wxqk/wxqk.env"
LK_DIR = "/opt/livekit"
# 浏览器走域名 TLS（墙 /888）；信令反代到新服 SFU。代理直连新服，不经旧机 SFU。
BROWSER_URL = os.environ.get("WXQK_LIVEKIT_BROWSER_URL") or "wss://xiangyuzhubao.xyz/livekit"
AGENT_URL = os.environ.get("WXQK_LIVEKIT_URL") or f"ws://{HOST}:7880"


def _ssh(host: str, password: str) -> paramiko.SSHClient:
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(host, username=USER, password=password, timeout=30, allow_agent=False, look_for_keys=False)
    return c


def _run(c: paramiko.SSHClient, cmd: str, timeout: int = 120) -> str:
    print("$", cmd[:160])
    _, o, e = c.exec_command(cmd, timeout=timeout)
    out = o.read().decode(errors="replace")
    err = e.read().decode(errors="replace")
    if out.strip():
        print(out.rstrip())
    if err.strip():
        print("ERR", err[:800])
    return out


def _upsert_env(existing: str, updates: dict[str, str]) -> str:
    lines = []
    seen = set()
    for raw in (existing or "").splitlines():
        if not raw.strip() or raw.lstrip().startswith("#") or "=" not in raw:
            lines.append(raw)
            continue
        key = raw.split("=", 1)[0].strip()
        if key in updates:
            lines.append(f"{key}={updates[key]}")
            seen.add(key)
        else:
            lines.append(raw)
    for key, val in updates.items():
        if key not in seen:
            lines.append(f"{key}={val}")
    return "\n".join(lines).rstrip() + "\n"


def _livekit_yaml(secret: str) -> str:
    return f"""# Managed by deploy_livekit.py
port: 7880
bind_addresses:
  - 0.0.0.0
log_level: info
rtc:
  tcp_port: 7881
  port_range_start: 50000
  port_range_end: 50200
  use_external_ip: true
  node_ip: {PUBLIC_IP}
  allow_tcp_fallback: true
keys:
  {API_KEY}: {secret}
room:
  auto_create: true
  empty_timeout: 60
  departure_timeout: 20
turn:
  enabled: false
"""


def _compose() -> str:
    return f"""services:
  livekit:
    image: livekit/livekit-server:v1.8.4
    network_mode: host
    restart: unless-stopped
    volumes:
      - {LK_DIR}/livekit.yaml:/etc/livekit.yaml:ro
    command: ["--config", "/etc/livekit.yaml"]
"""


def _systemd_unit() -> str:
    return f"""[Unit]
Description=LiveKit SFU for wxqk desktop
After=docker.service network-online.target
Requires=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory={LK_DIR}
ExecStart=/usr/bin/docker compose -f {LK_DIR}/docker-compose.yml up -d
ExecStop=/usr/bin/docker compose -f {LK_DIR}/docker-compose.yml down
TimeoutStartSec=120

[Install]
WantedBy=multi-user.target
"""


def _portal_tls_proxy_conf() -> str:
    # Reuse Let's Encrypt certs used by xiangyuzhubao if present; else self-signed fallback paths.
    return """# LiveKit signaling TLS front for browser wall (media UDP still hits wxqk host)
server {
    listen 7882 ssl http2;
    listen [::]:7882 ssl http2;
    server_name xiangyuzhubao.xyz www.xiangyuzhubao.xyz _;
    client_max_body_size 16m;

    ssl_certificate     /etc/nginx/ssl/livekit-front.crt;
    ssl_certificate_key /etc/nginx/ssl/livekit-front.key;
    ssl_protocols       TLSv1.2 TLSv1.3;

    location / {
        proxy_pass http://120.27.219.138:7880;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_buffering off;
    }
}
"""


def main() -> None:
    global API_SECRET
    if not API_SECRET:
        API_SECRET = secrets.token_hex(24)

    c = _ssh(HOST, PASSWORD)
    _run(c, "command -v docker >/dev/null || (curl -fsSL https://get.docker.com | sh)")
    _run(c, "docker compose version >/dev/null 2>&1 || docker --help | head -n 1")
    _run(c, f"mkdir -p {LK_DIR}")

    sftp = c.open_sftp()
    for name, body in (
        ("livekit.yaml", _livekit_yaml(API_SECRET)),
        ("docker-compose.yml", _compose()),
        ("livekit-docker.service", _systemd_unit()),
    ):
        remote = f"{LK_DIR}/{name}" if name != "livekit-docker.service" else f"/etc/systemd/system/{name}"
        with sftp.file(remote, "w") as f:
            f.write(body)
        print("wrote", remote)
    sftp.close()

    # firewall ports (best-effort)
    _run(
        c,
        "command -v ufw >/dev/null && ufw allow 7880/tcp && ufw allow 7881/tcp "
        "&& ufw allow 50000:50200/udp || true",
    )
    _run(
        c,
        "command -v firewall-cmd >/dev/null && firewall-cmd --permanent --add-port=7880/tcp "
        "--add-port=7881/tcp --add-port=50000-50200/udp && firewall-cmd --reload || true",
    )

    # env for wxqk
    try:
        with c.open_sftp() as sftp:
            try:
                with sftp.file(ENV_FILE, "r") as f:
                    existing = f.read().decode(errors="replace")
            except Exception:
                existing = ""
            updated = _upsert_env(
                existing,
                {
                    "WXQK_LIVEKIT_API_KEY": API_KEY,
                    "WXQK_LIVEKIT_API_SECRET": API_SECRET,
                    "WXQK_LIVEKIT_URL": AGENT_URL,
                    "WXQK_LIVEKIT_BROWSER_URL": BROWSER_URL,
                    "LIVEKIT_API_KEY": API_KEY,
                    "LIVEKIT_API_SECRET": API_SECRET,
                    "LIVEKIT_URL": AGENT_URL,
                },
            )
            with sftp.file(ENV_FILE, "w") as f:
                f.write(updated)
    except Exception as e:
        print("env update failed", e)

    _run(c, "systemctl daemon-reload")
    _run(c, "systemctl enable livekit-docker")
    _run(c, f"cd {LK_DIR} && docker compose pull && docker compose up -d", timeout=300)
    _run(c, "systemctl restart livekit-docker; sleep 2; docker ps --filter name=livekit --format '{{.Names}} {{.Status}}'")
    _run(c, "ss -lntp | grep -E ':7880|:7881' || true")
    _run(c, "systemctl restart wxqk; sleep 1; systemctl is-active wxqk")
    c.close()

    # Browser TLS front on portal host
    try:
        p = _ssh(PORTAL_HOST, PORTAL_PASS)
        _run(
            p,
            "mkdir -p /etc/nginx/ssl /etc/nginx/sites-enabled; "
            # Prefer existing LE cert for xiangyuzhubao; else copy/create
            "if [ -f /etc/letsencrypt/live/xiangyuzhubao.xyz/fullchain.pem ]; then "
            "  cp -f /etc/letsencrypt/live/xiangyuzhubao.xyz/fullchain.pem /etc/nginx/ssl/livekit-front.crt; "
            "  cp -f /etc/letsencrypt/live/xiangyuzhubao.xyz/privkey.pem /etc/nginx/ssl/livekit-front.key; "
            "elif [ -f /etc/nginx/ssl/xiangyuzhubao.xyz/fullchain.pem ]; then "
            "  cp -f /etc/nginx/ssl/xiangyuzhubao.xyz/fullchain.pem /etc/nginx/ssl/livekit-front.crt; "
            "  cp -f /etc/nginx/ssl/xiangyuzhubao.xyz/privkey.pem /etc/nginx/ssl/livekit-front.key; "
            "else "
            "  openssl req -x509 -nodes -newkey rsa:2048 -days 825 "
            "    -keyout /etc/nginx/ssl/livekit-front.key -out /etc/nginx/ssl/livekit-front.crt "
            "    -subj '/CN=xiangyuzhubao.xyz'; "
            "fi",
        )
        conf = _portal_tls_proxy_conf()
        loc = (
            f"# LiveKit signaling → wxqk host SFU\n"
            f"location ^~ /livekit/ {{\n"
            f"    proxy_pass http://{HOST}:7880/;\n"
            f"    proxy_http_version 1.1;\n"
            f"    proxy_set_header Host $host;\n"
            f"    proxy_set_header X-Real-IP $remote_addr;\n"
            f"    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n"
            f"    proxy_set_header X-Forwarded-Proto $scheme;\n"
            f"    proxy_set_header Upgrade $http_upgrade;\n"
            f"    proxy_set_header Connection $connection_upgrade;\n"
            f"    proxy_read_timeout 3600s;\n"
            f"    proxy_send_timeout 3600s;\n"
            f"    proxy_buffering off;\n"
            f"}}\n"
            f"location = /livekit {{ return 301 /livekit/; }}\n"
        )
        sftp = p.open_sftp()
        with sftp.file("/etc/nginx/sites-enabled/livekit-front-7882.conf", "w") as f:
            f.write(conf)
        with sftp.file("/etc/nginx/snippets/livekit-location.conf", "w") as f:
            f.write(loc)
        sftp.close()
        _run(p, "nginx -t && systemctl reload nginx")
        _run(p, "ss -lntp | grep ':7882' || true")
        _run(p, "ufw allow 7882/tcp || true")
        p.close()
        print("portal TLS front ok", BROWSER_URL)
    except Exception as e:
        print("portal TLS front skipped/failed:", e)

    print("done")
    print("AGENT_URL", AGENT_URL)
    print("BROWSER_URL", BROWSER_URL)
    print("API_KEY", API_KEY)
    print("API_SECRET", API_SECRET)


if __name__ == "__main__":
    main()
