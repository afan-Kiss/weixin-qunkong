#!/usr/bin/env python3
"""Install coturn TURN relay on the wxqk host and wire FACAI888_TURN_* into wxqk.env.

Keeps JPEG/WS desktop path untouched — only adds WebRTC ICE relay capability.
Old clients without WebRTC continue on JPEG; new clients get STUN + TURN.

Usage:
  set WXQK_SSH_HOST / WXQK_SSH_PASSWORD
  optionally FACAI888_TURN_SECRET / FACAI888_TURN_HOST
  py -3 deploy_turn.py
"""
from __future__ import annotations

import os
import secrets
import time
from pathlib import Path

import paramiko

HOST = os.environ.get("WXQK_SSH_HOST", "").strip()
USER = os.environ.get("WXQK_SSH_USER", "root")
PASSWORD = os.environ.get("WXQK_SSH_PASSWORD") or None
TURN_HOST = (os.environ.get("FACAI888_TURN_HOST") or HOST).strip()
TURN_SECRET = (os.environ.get("FACAI888_TURN_SECRET") or "").strip()
REALM = os.environ.get("FACAI888_TURN_REALM") or "wxqk-turn"
MIN_PORT = int(os.environ.get("FACAI888_TURN_MIN_PORT") or "49152")
MAX_PORT = int(os.environ.get("FACAI888_TURN_MAX_PORT") or "49551")
HERE = Path(__file__).resolve().parent
REMOTE = "/opt/wxqk"
ENV_FILE = "/etc/wxqk/wxqk.env"


def _turnserver_conf(external_ip: str, secret: str, private_ip: str = "") -> str:
    # Aliyun EIP: public IP is NOT on the NIC. Coturn must bind PRIVATE only and
    # advertise PUBLIC. Using external-ip=PUBLIC/PRIVATE made 4.5.2 try to bind
    # relay sockets to the public IP → errno=99 → ALLOCATE 508 → WebRTC falls to JPEG.
    priv = (private_ip or "").strip()
    if priv and priv != external_ip:
        listen_line = f"listening-ip={priv}"
        relay_line = f"relay-ip={priv}"
        external_line = f"external-ip={external_ip}"
    else:
        listen_line = "listening-ip=0.0.0.0"
        relay_line = f"relay-ip={external_ip}"
        external_line = f"external-ip={external_ip}"
    # TLS optional: reuse IP HTTPS certs if present (self-signed OK for many Electron clients).
    return f"""# Managed by deploy_turn.py — WebRTC TURN for wxqk
listening-port=3478
tls-listening-port=5349
{listen_line}
{relay_line}
{external_line}
min-port={MIN_PORT}
max-port={MAX_PORT}
fingerprint
use-auth-secret
static-auth-secret={secret}
realm={REALM}
server-name={REALM}
no-multicast-peers
no-cli
no-tlsv1
no-tlsv1_1
# Prefer UDP relay; TCP TURN still allowed for allocate (turn:?transport=tcp)
# Do not enable no-tcp-relay — corporate NATs often need TCP allocate.
cert=/etc/coturn/wxqk-ip.crt
pkey=/etc/coturn/wxqk-ip.key
log-file=/var/log/turnserver.log
verbose
simple-log
"""


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


def main() -> None:
    if not HOST:
        raise SystemExit("WXQK_SSH_HOST is required")
    if not PASSWORD:
        raise SystemExit("WXQK_SSH_PASSWORD is required (set env var, do NOT hardcode)")
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(HOST, username=USER, password=PASSWORD, timeout=30, allow_agent=False, look_for_keys=False)

    def run(cmd: str, timeout: int = 300) -> str:
        _, o, e = c.exec_command(cmd, timeout=timeout)
        out = o.read().decode("utf-8", "replace")
        err = e.read().decode("utf-8", "replace")
        print("$", cmd[:160])
        if out.strip():
            print(out[:4000])
        if err.strip():
            print("ERR", err[:2000])
        return out

    # Prefer existing secret on server so redeploys do not rotate credentials.
    secret = TURN_SECRET
    if not secret:
        existing = run(
            "grep -E '^FACAI888_TURN_SECRET=' /etc/wxqk/wxqk.env 2>/dev/null | head -1 | cut -d= -f2- || true"
        ).strip()
        secret = existing or secrets.token_urlsafe(32)

    # Detect public + private IPs (Aliyun ECS usually has only private NIC + EIP).
    pub = run("curl -4 -sS --max-time 5 ifconfig.me || curl -4 -sS --max-time 5 icanhazip.com || true").strip()
    external_ip = pub.splitlines()[-1].strip() if pub else HOST
    if not external_ip:
        external_ip = HOST
    priv = run("hostname -I | awk '{print $1}'").strip().splitlines()[-1].strip()
    print("TURN external-ip:", external_ip, "private-ip:", priv, "TURN host URL:", TURN_HOST)

    run("export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get install -y -qq coturn")
    # Enable daemon
    run("sed -i 's/^#*TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn || true")
    run("grep -q TURNSERVER_ENABLED=1 /etc/default/coturn || echo TURNSERVER_ENABLED=1 >> /etc/default/coturn")

    conf = _turnserver_conf(external_ip, secret, private_ip=priv)
    # Redact secret from preview to avoid console log leakage
    redacted = conf.replace(f"static-auth-secret={secret}", "static-auth-secret=****REDACTED****")
    print("--- turnserver.conf preview (secret redacted) ---\n", redacted)
    sftp = c.open_sftp()
    # Atomic replace so we never leave a duplicated/partial conf
    with sftp.file("/etc/turnserver.conf.tmp", "w") as f:
        f.write(conf)
        f.flush()
    run("mv -f /etc/turnserver.conf.tmp /etc/turnserver.conf && wc -l /etc/turnserver.conf")
    run("mkdir -p /etc/wxqk /etc/coturn")
    # coturn runs as turnserver — cannot read root-only nginx key
    run(
        "cp -f /etc/nginx/ssl/wxqk-ip.crt /etc/coturn/wxqk-ip.crt && "
        "cp -f /etc/nginx/ssl/wxqk-ip.key /etc/coturn/wxqk-ip.key && "
        "chown turnserver:turnserver /etc/coturn/wxqk-ip.crt /etc/coturn/wxqk-ip.key && "
        "chmod 640 /etc/coturn/wxqk-ip.crt /etc/coturn/wxqk-ip.key && "
        "touch /var/log/turnserver.log && chown turnserver:turnserver /var/log/turnserver.log"
    )
    run("mkdir -p /etc/wxqk")
    try:
        with sftp.file(ENV_FILE, "r") as f:
            old_env = f.read().decode("utf-8", "replace")
    except OSError:
        old_env = ""
    new_env = _upsert_env(
        old_env,
        {
            "FACAI888_TURN_SECRET": secret,
            "FACAI888_TURN_HOST": TURN_HOST,
            "FACAI888_TURN_REALM": REALM,
            "WXQK_TURN_SECRET": secret,
            "WXQK_TURN_HOST": TURN_HOST,
        },
    )
    with sftp.file(ENV_FILE, "w") as f:
        f.write(new_env)
    # Upload latest webrtc_session.py (host default + TURN wiring)
    local_wrs = HERE / "webrtc_session.py"
    if local_wrs.exists():
        sftp.put(str(local_wrs), f"{REMOTE}/webrtc_session.py")
        print("uploaded webrtc_session.py")
    sftp.close()

    # Firewall (best-effort). Cloud security groups must also allow these ports.
    run(
        f"command -v ufw >/dev/null && ufw allow 3478/udp && ufw allow 3478/tcp "
        f"&& ufw allow 5349/tcp && ufw allow 5349/udp "
        f"&& ufw allow {MIN_PORT}:{MAX_PORT}/udp && ufw allow {MIN_PORT}:{MAX_PORT}/tcp || true"
    )
    run(
        f"command -v firewall-cmd >/dev/null && firewall-cmd --permanent --add-port=3478/udp "
        f"--add-port=3478/tcp --add-port=5349/tcp --add-port=5349/udp "
        f"--add-port={MIN_PORT}-{MAX_PORT}/udp --add-port={MIN_PORT}-{MAX_PORT}/tcp "
        f"&& firewall-cmd --reload || true"
    )

    run("systemctl enable coturn || systemctl enable turnserver || true")
    run("systemctl restart coturn || systemctl restart turnserver || true")
    time.sleep(1.2)
    run("systemctl --no-pager --full status coturn 2>/dev/null | head -20 || systemctl --no-pager --full status turnserver 2>/dev/null | head -20 || true")
    run("ss -lntp | grep -E ':3478|:5349' || true")

    # Restart wxqk so ice_config() picks up env
    run("systemctl restart wxqk.service && sleep 1 && systemctl is-active wxqk.service")

    # Local smoke: python credential + ice_config
    smoke = r"""
import os, json
os.environ['FACAI888_TURN_SECRET'] = open('/etc/wxqk/wxqk.env').read().split('FACAI888_TURN_SECRET=')[1].splitlines()[0].strip()
os.environ['FACAI888_TURN_HOST'] = open('/etc/wxqk/wxqk.env').read().split('FACAI888_TURN_HOST=')[1].splitlines()[0].strip()
import sys
sys.path.insert(0, '/opt/wxqk')
import webrtc_session as w
print(json.dumps(w.ice_config(), ensure_ascii=False)[:800])
"""
    run(f"python3 - <<'PY'\n{smoke}\nPY")

    print()
    print("done.")
    print(f"  TURN host: {TURN_HOST}:3478 (udp/tcp), turns :5349")
    print(f"  relay ports: {MIN_PORT}-{MAX_PORT}")
    print(f"  secret stored in {ENV_FILE} (FACAI888_TURN_SECRET)")
    print("  JPEG/WS desktop path unchanged — old clients keep working.")
    print("  IMPORTANT: open Alibaba/security-group for 3478/udp+tcp, 5349/tcp, and relay UDP range.")
    c.close()


if __name__ == "__main__":
    main()
