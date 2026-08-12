#!/usr/bin/env python3
"""Finish Let's Encrypt IP cert nginx switch + renew automation (no secrets).

SSH:
  WXQK_SSH_HOST              required (no hardcoded production IP)
  WXQK_SSH_USER              default root
  WXQK_SSH_PASSWORD          optional (prefer keys)
  WXQK_SSH_KNOWN_HOSTS       optional path to known_hosts file
  WXQK_SSH_HOST_FINGERPRINT  optional sha256:BASE64 or hex fingerprint of host key
                             (accepted only when host is missing from known_hosts)

Fail closed: unknown / mismatched host keys are rejected (no AutoAddPolicy).

TLS nginx template uses WXQK_PUBLIC_IP / WXQK_MESH_HTTPS_PORT (defaults only for local dry-run; production must set env).
"""
from __future__ import annotations

import base64
import hashlib
import os
import sys
from pathlib import Path

import paramiko
from paramiko import SSHException

HOST = os.environ.get("WXQK_SSH_HOST", "").strip()
USER = os.environ.get("WXQK_SSH_USER", "root").strip()
PASSWORD = os.environ.get("WXQK_SSH_PASSWORD") or None
PUBLIC_IP = os.environ.get("WXQK_PUBLIC_IP", "").strip() or HOST
MESH_HTTPS_PORT = str(os.environ.get("WXQK_MESH_HTTPS_PORT", "8444") or "8444").strip()
MESH_UPSTREAM = str(os.environ.get("WXQK_MESH_UPSTREAM", "127.0.0.1:9443") or "127.0.0.1:9443").strip()
KNOWN_HOSTS = os.environ.get("WXQK_SSH_KNOWN_HOSTS", "").strip()
HOST_FINGERPRINT = os.environ.get("WXQK_SSH_HOST_FINGERPRINT", "").strip()


def _key_fingerprints(key: paramiko.PKey) -> set[str]:
    """Return comparable fingerprints (sha256 base64 OpenSSH-style + hex md5/sha256)."""
    out: set[str] = set()
    try:
        raw = key.asbytes()
    except Exception:
        raw = key.blob  # type: ignore[attr-defined]
    sha = hashlib.sha256(raw).digest()
    b64 = base64.b64encode(sha).decode("ascii").rstrip("=")
    out.add(f"sha256:{b64}".lower())
    out.add(b64.lower())
    out.add(hashlib.sha256(raw).hexdigest().lower())
    try:
        # OpenSSH-style MD5 hex with colons
        md5 = hashlib.md5(raw).hexdigest()
        out.add(":".join(md5[i : i + 2] for i in range(0, len(md5), 2)).lower())
        out.add(md5.lower())
    except Exception:
        pass
    return out


class _FingerprintOrRejectPolicy(paramiko.MissingHostKeyPolicy):
    """Accept missing host key only when WXQK_SSH_HOST_FINGERPRINT matches; else fail closed."""

    def __init__(self, expected: str) -> None:
        self.expected = expected.strip().lower()

    def missing_host_key(self, client: paramiko.SSHClient, hostname: str, key: paramiko.PKey) -> None:
        if not self.expected:
            raise SSHException(
                f"unknown host key for {hostname}: add to known_hosts or set WXQK_SSH_HOST_FINGERPRINT"
            )
        fps = _key_fingerprints(key)
        exp = self.expected
        if exp.startswith("sha256:"):
            ok = exp in fps
        else:
            ok = exp in fps or f"sha256:{exp}" in fps
        if not ok:
            raise SSHException(
                f"SSH host key fingerprint mismatch for {hostname} (fail closed)"
            )
        client.get_host_keys().add(hostname, key.get_name(), key)
        print(f"[ssh] accepted host key for {hostname} via WXQK_SSH_HOST_FINGERPRINT")


def connect() -> paramiko.SSHClient:
    if not HOST:
        raise SystemExit("WXQK_SSH_HOST is required (no hardcoded production default)")
    if not PUBLIC_IP:
        raise SystemExit("WXQK_PUBLIC_IP or WXQK_SSH_HOST required for nginx template")

    c = paramiko.SSHClient()
    c.load_system_host_keys()
    paths: list[Path] = []
    if KNOWN_HOSTS:
        paths.append(Path(KNOWN_HOSTS))
    else:
        paths.append(Path.home() / ".ssh" / "known_hosts")
    for p in paths:
        if p.is_file():
            c.load_host_keys(str(p))
            print(f"[ssh] loaded known_hosts: {p}")

    if HOST_FINGERPRINT:
        c.set_missing_host_key_policy(_FingerprintOrRejectPolicy(HOST_FINGERPRINT))
    else:
        c.set_missing_host_key_policy(paramiko.RejectPolicy())

    try:
        c.connect(
            HOST,
            username=USER,
            password=PASSWORD,
            timeout=30,
            allow_agent=PASSWORD is None,
            look_for_keys=PASSWORD is None,
        )
    except paramiko.BadHostKeyException as exc:
        raise SystemExit(
            f"SSH host key mismatch for {HOST} (fail closed): {exc}"
        ) from exc
    except SSHException as exc:
        raise SystemExit(f"SSH host key / auth failure for {HOST} (fail closed): {exc}") from exc
    return c


def mesh_nginx_conf(public_ip: str, https_port: str, upstream: str) -> str:
    return f"""# WXQK MeshCentral reverse proxy — Let's Encrypt IP certificate (shortlived)
# Public: https://{public_ip}:{https_port}  →  {upstream}
# Rollback self-signed kept at /etc/nginx/ssl/rollback-selfsigned/

upstream wxqk_meshcentral {{
    server {upstream};
    keepalive 32;
}}

server {{
    listen {https_port} ssl http2;
    listen [::]:{https_port} ssl http2;
    server_name {public_ip} _;

    ssl_certificate     /etc/letsencrypt/live/{public_ip}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/{public_ip}/privkey.pem;
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


DEPLOY_HOOK = r"""#!/bin/bash
set -euo pipefail
LOG=/var/log/letsencrypt/wxqk-ip-renew.log
EXPECTED=/etc/wxqk/le-ip-expected-spki.txt
{
  echo "[$(date -Iseconds)] deploy-hook: reload nginx after renew"
  /usr/sbin/nginx -t
  /bin/systemctl reload nginx
  echo "[$(date -Iseconds)] nginx reloaded OK"
  if [[ -n "${RENEWED_LINEAGE:-}" && -f "${RENEWED_LINEAGE}/cert.pem" ]]; then
    cur=$(openssl x509 -in "${RENEWED_LINEAGE}/cert.pem" -pubkey -noout \
      | openssl pkey -pubin -outform DER \
      | openssl dgst -sha256 -binary \
      | openssl base64 | tr -d '\r\n')
    cur_pin="sha256/${cur}"
    echo "[$(date -Iseconds)] renewed_leaf_spki=${cur_pin}"
    if [[ -f "$EXPECTED" ]]; then
      exp=$(tr -d ' \r\n' <"$EXPECTED")
      [[ "$exp" == sha256/* ]] || exp="sha256/${exp}"
      if [[ "$cur_pin" != "$exp" ]]; then
        echo "[$(date -Iseconds)] CRITICAL SPKI_CHANGED expected=${exp} actual=${cur_pin}"
        echo "[$(date -Iseconds)] CRITICAL: reuse-key may be off; published clients will TLS_CERT_PIN_MISMATCH — do NOT treat this renew as pin-safe"
      else
        echo "[$(date -Iseconds)] SPKI_OK matches expected pin"
      fi
    else
      echo "[$(date -Iseconds)] WARN: missing ${EXPECTED}; cannot verify SPKI stability"
    fi
  fi
} >>"$LOG" 2>&1
"""

FAILED_HOOK = r"""#!/bin/bash
LOG=/var/log/letsencrypt/wxqk-ip-renew.log
echo "[$(date -Iseconds)] RENEW_FAILED lineage=${RENEWED_LINEAGE:-unknown} exit=${EXIT_STATUS:-?}" >>"$LOG"
"""


def check_script(public_ip: str) -> str:
    return f"""#!/bin/bash
set -euo pipefail
LOG=/var/log/letsencrypt/wxqk-ip-cert-check.log
CERT=/etc/letsencrypt/live/{public_ip}/cert.pem
EXPECTED=/etc/wxqk/le-ip-expected-spki.txt
RENEWAL=/etc/letsencrypt/renewal/{public_ip}.conf
{{
  echo "[$(date -Iseconds)] cert check"
  if [[ ! -f "$CERT" ]]; then
    echo "MISSING $CERT"
    exit 2
  fi
  openssl x509 -in "$CERT" -noout -subject -issuer -dates
  openssl x509 -in "$CERT" -noout -ext subjectAltName 2>/dev/null || true
  if [[ -f "$RENEWAL" ]]; then
    if grep -Eq '^[[:space:]]*reuse_key[[:space:]]*=[[:space:]]*True' "$RENEWAL"; then
      echo "reuse_key=True"
    else
      echo "CRITICAL reuse_key_missing_or_false in $RENEWAL — leaf SPKI may rotate on renew"
    fi
  fi
  cur=$(openssl x509 -in "$CERT" -pubkey -noout \
    | openssl pkey -pubin -outform DER \
    | openssl dgst -sha256 -binary \
    | openssl base64 | tr -d '\r\n')
  cur_pin="sha256/${{cur}}"
  echo "leaf_spki=${{cur_pin}}"
  if [[ -f "$EXPECTED" ]]; then
    exp=$(tr -d ' \\r\\n' <"$EXPECTED")
    [[ "$exp" == sha256/* ]] || exp="sha256/${{exp}}"
    if [[ "$cur_pin" != "$exp" ]]; then
      echo "CRITICAL SPKI_CHANGED expected=${{exp}} actual=${{cur_pin}}"
      echo "CRITICAL: published Electron clients pin this leaf; renew is NOT pin-safe until pins are rotated"
      # do not auto-rollback to an expired cert
    else
      echo "SPKI_OK"
    fi
  else
    echo "WARN: missing $EXPECTED (write pin at first issue / reconfigure)"
  fi
  end=$(openssl x509 -in "$CERT" -noout -enddate | cut -d= -f2)
  end_epoch=$(date -d "$end" +%s)
  now=$(date +%s)
  left=$(( (end_epoch-now)/3600 ))
  echo "hours_left=$left"
  if (( left < 48 )); then
    echo "WARN: less than 48h left — forcing renew attempt (inherits reuse_key from renewal conf)"
    /usr/bin/certbot renew --cert-name {public_ip} --quiet || echo "RENEW_CMD_FAILED $?"
    # re-check SPKI after renew nudge
    cur2=$(openssl x509 -in "$CERT" -pubkey -noout \
      | openssl pkey -pubin -outform DER \
      | openssl dgst -sha256 -binary \
      | openssl base64 | tr -d '\r\n')
    cur2_pin="sha256/${{cur2}}"
    echo "leaf_spki_after_renew_nudge=${{cur2_pin}}"
    if [[ -f "$EXPECTED" ]]; then
      exp=$(tr -d ' \\r\\n' <"$EXPECTED")
      [[ "$exp" == sha256/* ]] || exp="sha256/${{exp}}"
      if [[ "$cur2_pin" != "$exp" ]]; then
        echo "CRITICAL SPKI_CHANGED_AFTER_RENEW expected=${{exp}} actual=${{cur2_pin}}"
      fi
    fi
  fi
}} >>"$LOG" 2>&1
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
    c = connect()
    sftp = c.open_sftp()
    try:
        run(c, "mkdir -p /etc/letsencrypt/renewal-hooks/deploy /etc/letsencrypt/renewal-hooks/failed /var/log/letsencrypt")
        run(c, f"test -f /etc/letsencrypt/live/{PUBLIC_IP}/fullchain.pem")
        run(
            c,
            "mkdir -p /etc/nginx/backup-mesh && "
            "cp -a /etc/nginx/sites-available/wxqk-mesh-8444.conf "
            "/etc/nginx/backup-mesh/wxqk-mesh-8444.conf.bak-before-le 2>/dev/null || true",
            check=False,
        )
        run(c, "rm -f /etc/nginx/sites-enabled/*.bak* 2>/dev/null || true", check=False)

        conf = mesh_nginx_conf(PUBLIC_IP, MESH_HTTPS_PORT, MESH_UPSTREAM)
        with sftp.file("/etc/nginx/sites-available/wxqk-mesh-8444.conf", "w") as f:
            f.write(conf)
        run(
            c,
            "ln -sfn /etc/nginx/sites-available/wxqk-mesh-8444.conf /etc/nginx/sites-enabled/wxqk-mesh-8444.conf",
        )
        with sftp.file("/etc/letsencrypt/renewal-hooks/deploy/wxqk-reload-nginx.sh", "w") as f:
            f.write(DEPLOY_HOOK)
        with sftp.file("/etc/letsencrypt/renewal-hooks/failed/wxqk-log-failure.sh", "w") as f:
            f.write(FAILED_HOOK)
        with sftp.file("/usr/local/sbin/wxqk-ip-cert-check", "w") as f:
            f.write(check_script(PUBLIC_IP))
        with sftp.file("/etc/systemd/system/wxqk-ip-cert-check.service", "w") as f:
            f.write(UNIT)
        with sftp.file("/etc/systemd/system/wxqk-ip-cert-check.timer", "w") as f:
            f.write(TIMER)
    finally:
        sftp.close()

    run(
        c,
        "chmod 755 /etc/letsencrypt/renewal-hooks/deploy/wxqk-reload-nginx.sh "
        "/etc/letsencrypt/renewal-hooks/failed/wxqk-log-failure.sh /usr/local/sbin/wxqk-ip-cert-check",
    )
    run(c, "nginx -t && systemctl reload nginx")
    run(c, "systemctl daemon-reload && systemctl enable --now wxqk-ip-cert-check.timer")
    run(
        c,
        f"openssl x509 -in /etc/letsencrypt/live/{PUBLIC_IP}/fullchain.pem -noout -subject -issuer -dates",
    )
    run(
        c,
        f"openssl x509 -in /etc/letsencrypt/live/{PUBLIC_IP}/fullchain.pem -noout -ext subjectAltName",
        check=False,
    )
    run(c, f"curl -sI --max-time 15 https://{PUBLIC_IP}:{MESH_HTTPS_PORT}/ | head -n 20", check=False)
    c.close()
    print("FINISH_IP_TLS_OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
