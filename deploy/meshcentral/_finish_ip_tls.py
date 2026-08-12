#!/usr/bin/env python3
"""Finish Let's Encrypt IP cert nginx switch + renew automation (no secrets)."""
from __future__ import annotations

import os
import sys
import time

import paramiko

HOST = os.environ.get("WXQK_SSH_HOST", "120.27.219.138").strip()
USER = os.environ.get("WXQK_SSH_USER", "root").strip()
PASSWORD = os.environ.get("WXQK_SSH_PASSWORD") or None

MESH_CONF = r"""# WXQK MeshCentral reverse proxy — Let's Encrypt IP certificate (shortlived)
# Public: https://120.27.219.138:8444  →  127.0.0.1:9443
# Rollback self-signed kept at /etc/nginx/ssl/rollback-selfsigned/

upstream wxqk_meshcentral {
    server 127.0.0.1:9443;
    keepalive 32;
}

server {
    listen 8444 ssl http2;
    listen [::]:8444 ssl http2;
    server_name 120.27.219.138 _;

    ssl_certificate     /etc/letsencrypt/live/120.27.219.138/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/120.27.219.138/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_session_timeout 1d;
    ssl_session_cache shared:MeshSSL:10m;

    client_max_body_size 512m;
    proxy_connect_timeout 60s;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;

    location / {
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
    }
}
"""

DEPLOY_HOOK = r"""#!/bin/bash
set -euo pipefail
LOG=/var/log/letsencrypt/wxqk-ip-renew.log
{
  echo "[$(date -Iseconds)] deploy-hook: reload nginx after renew"
  /usr/sbin/nginx -t
  /bin/systemctl reload nginx
  echo "[$(date -Iseconds)] nginx reloaded OK"
} >>"$LOG" 2>&1
"""

FAILED_HOOK = r"""#!/bin/bash
LOG=/var/log/letsencrypt/wxqk-ip-renew.log
echo "[$(date -Iseconds)] RENEW_FAILED lineage=${RENEWED_LINEAGE:-unknown} exit=${EXIT_STATUS:-?}" >>"$LOG"
"""

CHECK_SCRIPT = r"""#!/bin/bash
set -euo pipefail
LOG=/var/log/letsencrypt/wxqk-ip-cert-check.log
CERT=/etc/letsencrypt/live/120.27.219.138/fullchain.pem
{
  echo "[$(date -Iseconds)] cert check"
  if [[ ! -f "$CERT" ]]; then
    echo "MISSING $CERT"
    exit 2
  fi
  openssl x509 -in "$CERT" -noout -subject -issuer -dates
  openssl x509 -in "$CERT" -noout -ext subjectAltName 2>/dev/null || true
  end=$(openssl x509 -in "$CERT" -noout -enddate | cut -d= -f2)
  end_epoch=$(date -d "$end" +%s)
  now=$(date +%s)
  left=$(( (end_epoch-now)/3600 ))
  echo "hours_left=$left"
  if (( left < 48 )); then
    echo "WARN: less than 48h left — forcing renew attempt"
    /usr/bin/certbot renew --cert-name 120.27.219.138 --quiet || echo "RENEW_CMD_FAILED $?"
  fi
} >>"$LOG" 2>&1
"""

UNIT = """[Unit]
Description=WXQK Let's Encrypt IP cert validity check / renew nudge
After=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/wxqk-ip-cert-check
"""

TIMER = """[Unit]
Description=Run WXQK IP cert check every 12 hours

[Timer]
OnBootSec=5min
OnUnitActiveSec=12h
AccuracySec=5min
Persistent=true
RandomizedDelaySec=10min

[Install]
WantedBy=timers.target
"""


def run(c: paramiko.SSHClient, cmd: str, timeout: int = 180, check: bool = True) -> str:
    print("+", cmd[:200])
    _, stdout, stderr = c.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode("utf-8", "replace")
    err = stderr.read().decode("utf-8", "replace")
    code = stdout.channel.recv_exit_status()
    if out.strip():
        print(out[:5000])
    if err.strip():
        print("ERR", err[:2000])
    if check and code != 0:
        raise SystemExit(f"exit {code}: {cmd[:120]}")
    return out


def main() -> int:
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(HOST, username=USER, password=PASSWORD, timeout=30, allow_agent=PASSWORD is None, look_for_keys=PASSWORD is None)
    sftp = c.open_sftp()
    try:
        run(c, "mkdir -p /etc/letsencrypt/renewal-hooks/deploy /etc/letsencrypt/renewal-hooks/failed /var/log/letsencrypt")
        run(c, "test -f /etc/letsencrypt/live/120.27.219.138/fullchain.pem")
        run(c, "mkdir -p /etc/nginx/backup-mesh && cp -a /etc/nginx/sites-available/wxqk-mesh-8444.conf /etc/nginx/backup-mesh/wxqk-mesh-8444.conf.bak-before-le 2>/dev/null || true", check=False)
        run(c, "rm -f /etc/nginx/sites-enabled/*.bak* /etc/nginx/sites-enabled/wxqk-mesh-8444.conf.bak* 2>/dev/null || true", check=False)

        # Always write the real file under sites-available (sites-enabled is a symlink)
        with sftp.file("/etc/nginx/sites-available/wxqk-mesh-8444.conf", "w") as f:
            f.write(MESH_CONF)
        run(
            c,
            "ln -sfn /etc/nginx/sites-available/wxqk-mesh-8444.conf /etc/nginx/sites-enabled/wxqk-mesh-8444.conf",
        )
        with sftp.file("/etc/letsencrypt/renewal-hooks/deploy/wxqk-reload-nginx.sh", "w") as f:
            f.write(DEPLOY_HOOK)
        with sftp.file("/etc/letsencrypt/renewal-hooks/failed/wxqk-log-failure.sh", "w") as f:
            f.write(FAILED_HOOK)
        with sftp.file("/usr/local/sbin/wxqk-ip-cert-check", "w") as f:
            f.write(CHECK_SCRIPT)
        with sftp.file("/etc/systemd/system/wxqk-ip-cert-check.service", "w") as f:
            f.write(UNIT)
        with sftp.file("/etc/systemd/system/wxqk-ip-cert-check.timer", "w") as f:
            f.write(TIMER)
    finally:
        sftp.close()

    run(c, "chmod 755 /etc/letsencrypt/renewal-hooks/deploy/wxqk-reload-nginx.sh /etc/letsencrypt/renewal-hooks/failed/wxqk-log-failure.sh /usr/local/sbin/wxqk-ip-cert-check")
    run(c, "nginx -t && systemctl reload nginx")
    run(c, "systemctl daemon-reload && systemctl enable --now wxqk-ip-cert-check.timer")
    run(c, "openssl x509 -in /etc/letsencrypt/live/120.27.219.138/fullchain.pem -noout -subject -issuer -dates")
    run(c, "openssl x509 -in /etc/letsencrypt/live/120.27.219.138/fullchain.pem -noout -ext subjectAltName", check=False)
    run(c, "curl -sI --max-time 15 https://120.27.219.138:8444/ | head -n 20", check=False)
    run(
        c,
        "echo | openssl s_client -connect 120.27.219.138:8444 -servername 120.27.219.138 2>/dev/null | openssl x509 -noout -issuer -subject -dates",
        check=False,
    )

    # Drop custom CA for Mesh — public LE chain
    run(
        c,
        r"""python3 - <<'PY'
from pathlib import Path
p = Path('/etc/wxqk/wxqk.env')
lines = p.read_text().splitlines()
out = []
removed = False
for ln in lines:
    if ln.startswith('WXQK_MESH_TLS_CA='):
        removed = True
        continue
    out.append(ln)
p.write_text('\n'.join(out) + '\n')
p.chmod(0o600)
print('removed_WXQK_MESH_TLS_CA', removed)
for ln in out:
    if ln.startswith('WXQK_MESH_') and not any(x in ln for x in ('KEY', 'SECRET', 'PASSWORD', 'TOKEN')):
        print(ln)
PY""",
    )
    run(c, "systemctl restart wxqk && sleep 2 && systemctl is-active wxqk")
    run(
        c,
        """set -a; . /etc/wxqk/wxqk.env; set +a; cd /opt/wxqk; python3 - <<'PY'
import json
from meshcentral_client import health_check
print(json.dumps(health_check(), ensure_ascii=False)[:600])
PY""",
    )
    run(c, "grep -E 'pref_profil|profile|ip_address|renew_before|server' /etc/letsencrypt/renewal/120.27.219.138.conf | head -40", check=False)
    run(c, "systemctl list-timers --all | grep -Ei 'certbot|wxqk-ip' || true", check=False)
    run(c, "/usr/local/sbin/wxqk-ip-cert-check; tail -n 20 /var/log/letsencrypt/wxqk-ip-cert-check.log", check=False)
    # dry-run renew (may fail near issuance due to rate; non-fatal)
    run(c, "certbot renew --cert-name 120.27.219.138 --dry-run", timeout=180, check=False)
    c.close()
    print("FINISH_IP_TLS_OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
