#!/usr/bin/env python3
"""Install LiveKit server binary (no Docker) on wxqk host and wire wxqk.env."""
from __future__ import annotations

import os
import secrets
from pathlib import Path

import paramiko

HOST = os.environ.get("WXQK_SSH_HOST", "").strip()
USER = os.environ.get("WXQK_SSH_USER", "root")
PASSWORD = os.environ.get("WXQK_SSH_PASSWORD") or None
API_KEY = (os.environ.get("WXQK_LIVEKIT_API_KEY") or "wxqk").strip()
API_SECRET = (os.environ.get("WXQK_LIVEKIT_API_SECRET") or "").strip()
PUBLIC_IP = (os.environ.get("WXQK_LIVEKIT_NODE_IP") or HOST).strip()
ENV_FILE = "/etc/wxqk/wxqk.env"
LK_DIR = "/opt/livekit"
# Prefer env secret already written by previous deploy attempt
BROWSER_URL = os.environ.get("WXQK_LIVEKIT_BROWSER_URL") or "wss://xiangyuzhubao.xyz:7882"
AGENT_URL = os.environ.get("WXQK_LIVEKIT_URL") or f"ws://{HOST}:7880"
# Known release asset
LK_VER = os.environ.get("WXQK_LIVEKIT_VERSION") or "1.8.4"
LK_URL = (
    os.environ.get("WXQK_LIVEKIT_BIN_URL")
    or f"https://github.com/livekit/livekit/releases/download/v{LK_VER}/livekit_{LK_VER}_linux_amd64.tar.gz"
)


def _run(c: paramiko.SSHClient, cmd: str, timeout: int = 180) -> str:
    print("$", cmd[:180])
    _, o, e = c.exec_command(cmd, timeout=timeout)
    out = o.read().decode(errors="replace")
    err = e.read().decode(errors="replace")
    if out.strip():
        print(out.rstrip()[:2000])
    if err.strip():
        print("ERR", err[:1000])
    return out


def _upsert_env(existing: str, updates: dict[str, str]) -> str:
    lines, seen = [], set()
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
    global API_SECRET
    if not HOST:
        raise SystemExit("WXQK_SSH_HOST is required")
    if not PASSWORD:
        raise SystemExit("WXQK_SSH_PASSWORD is required (set env var, do NOT hardcode)")
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(HOST, username=USER, password=PASSWORD, timeout=30, allow_agent=False, look_for_keys=False)

    # Reuse secret from env file if present
    existing = ""
    try:
        with c.open_sftp() as sftp:
            try:
                with sftp.file(ENV_FILE, "r") as f:
                    existing = f.read().decode(errors="replace")
            except Exception:
                existing = ""
    except Exception:
        existing = ""
    for line in existing.splitlines():
        if line.startswith("WXQK_LIVEKIT_API_SECRET="):
            API_SECRET = line.split("=", 1)[1].strip() or API_SECRET
        if line.startswith("WXQK_LIVEKIT_API_KEY="):
            # keep file key unless overridden
            pass
    if not API_SECRET:
        API_SECRET = secrets.token_hex(24)

    yaml = f"""port: 7880
bind_addresses:
  - \"0.0.0.0\"
log_level: info
rtc:
  tcp_port: 7881
  port_range_start: 50000
  port_range_end: 50200
  use_external_ip: true
  node_ip: {PUBLIC_IP}
  allow_tcp_fallback: true
keys:
  {API_KEY}: {API_SECRET}
room:
  auto_create: true
  empty_timeout: 60
  departure_timeout: 20
turn:
  enabled: false
"""
    unit = f"""[Unit]
Description=LiveKit SFU (wxqk desktop)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory={LK_DIR}
ExecStart={LK_DIR}/livekit-server --config {LK_DIR}/livekit.yaml
Restart=always
RestartSec=2
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
"""

    _run(c, f"mkdir -p {LK_DIR}")
    sftp = c.open_sftp()
    with sftp.file(f"{LK_DIR}/livekit.yaml", "w") as f:
        f.write(yaml)
    with sftp.file("/etc/systemd/system/livekit.service", "w") as f:
        f.write(unit)
    sftp.close()

    # Download binary (try github, then ghproxy mirrors)
    _run(
        c,
        f"set -e; cd /tmp; "
        f"rm -rf lkbin && mkdir lkbin && cd lkbin; "
        f"OK=0; "
        f"for U in '{LK_URL}' "
        f"'https://mirror.ghproxy.com/{LK_URL}' "
        f"'https://ghfast.top/{LK_URL}'; do "
        f"  echo TRY $U; "
        f"  if curl -fL --connect-timeout 20 --max-time 180 -o lk.tgz \"$U\"; then OK=1; break; fi; "
        f"done; "
        f"test $OK = 1; "
        f"tar -xzf lk.tgz; "
        f"BIN=$(find . -type f -name 'livekit-server' | head -n1); "
        f"test -n \"$BIN\"; "
        f"install -m 755 \"$BIN\" {LK_DIR}/livekit-server; "
        f"{LK_DIR}/livekit-server --version || true",
        timeout=300,
    )

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
    with c.open_sftp() as sftp:
        with sftp.file(ENV_FILE, "w") as f:
            f.write(updated)

    _run(c, "systemctl disable --now livekit-docker 2>/dev/null || true")
    _run(c, "systemctl daemon-reload && systemctl enable livekit && systemctl restart livekit")
    # Aliyun hosts often have INPUT DROP with explicit ACCEPTs (TURN style); ufw alone is not enough
    _run(
        c,
        "iptables -C INPUT -p tcp --dport 7880 -j ACCEPT 2>/dev/null || iptables -I INPUT 1 -p tcp --dport 7880 -j ACCEPT; "
        "iptables -C INPUT -p tcp --dport 7881 -j ACCEPT 2>/dev/null || iptables -I INPUT 1 -p tcp --dport 7881 -j ACCEPT; "
        "iptables -C INPUT -p udp --dport 50000:50200 -j ACCEPT 2>/dev/null || iptables -I INPUT 1 -p udp --dport 50000:50200 -j ACCEPT; "
        "mkdir -p /etc/iptables; iptables-save > /etc/iptables/rules.v4 || true",
    )
    _run(c, "sleep 1; systemctl is-active livekit; ss -lntp | grep -E ':7880|:7881' || true")
    _run(c, "systemctl restart wxqk; sleep 1; systemctl is-active wxqk")
    c.close()
    print("done")
    print("AGENT_URL", AGENT_URL)
    print("BROWSER_URL", BROWSER_URL)
    print("API_KEY", API_KEY)
    print("LiveKit API secret configured successfully")


if __name__ == "__main__":
    main()
