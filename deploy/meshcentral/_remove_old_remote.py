#!/usr/bin/env python3
"""Remove LiveKit / coturn old remote stack from production (keep Mesh + wxqk)."""
from __future__ import annotations

import json
import os
import sys

import paramiko
from aliyunsdkcore.client import AcsClient
from aliyunsdkcore.request import CommonRequest

HOST = os.environ.get("WXQK_SSH_HOST", "120.27.219.138").strip()
USER = os.environ.get("WXQK_SSH_USER", "root").strip()
PASSWORD = os.environ.get("WXQK_SSH_PASSWORD") or None
AK = os.environ.get("ALIYUN_ACCESS_KEY_ID") or ""
SK = os.environ.get("ALIYUN_ACCESS_KEY_SECRET") or ""
REGION = "cn-hangzhou"
SG = "sg-bp1f1ssw1d7cevreg75o"


def run(c: paramiko.SSHClient, cmd: str, timeout: int = 180, check: bool = True) -> str:
    print("+", cmd[:200])
    _, stdout, stderr = c.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode("utf-8", "replace")
    err = stderr.read().decode("utf-8", "replace")
    code = stdout.channel.recv_exit_status()
    if out.strip():
        print(out[:4000])
    if err.strip():
        print("ERR", err[:1200])
    if check and code != 0:
        raise SystemExit(f"exit {code}: {cmd[:120]}")
    return out


def revoke_sg_ports(ports: list[int]) -> None:
    if not AK or not SK:
        print("SKIP SG: no AccessKey in env")
        return
    client = AcsClient(AK, SK, REGION)
    # list current rules
    req = CommonRequest()
    req.set_accept_format("json")
    req.set_domain(f"ecs.{REGION}.aliyuncs.com")
    req.set_method("POST")
    req.set_protocol_type("https")
    req.set_version("2014-05-26")
    req.set_action_name("DescribeSecurityGroupAttribute")
    req.add_query_param("RegionId", REGION)
    req.add_query_param("SecurityGroupId", SG)
    req.add_query_param("Direction", "ingress")
    resp = json.loads(client.do_action_with_exception(req))
    perms = ((resp.get("Permissions") or {}).get("Permission") or [])
    wanted = {f"{p}/{p}" for p in ports}
    # also UDP ranges used by turn/livekit
    extra_ranges = {
        "3478/3478",
        "5349/5349",
        "7880/7880",
        "7881/7881",
        "49152/49200",
        "49152/49551",
        "50000/50200",
    }
    targets = wanted | extra_ranges
    for p in perms:
        pr = str(p.get("PortRange") or "")
        proto = str(p.get("IpProtocol") or "").lower()
        if pr not in targets:
            continue
        # keep nothing of old remote media ports
        print("revoke SG", pr, proto, p.get("SourceCidrIp"))
        r = CommonRequest()
        r.set_accept_format("json")
        r.set_domain(f"ecs.{REGION}.aliyuncs.com")
        r.set_method("POST")
        r.set_protocol_type("https")
        r.set_version("2014-05-26")
        r.set_action_name("RevokeSecurityGroup")
        r.add_query_param("RegionId", REGION)
        r.add_query_param("SecurityGroupId", SG)
        r.add_query_param("IpProtocol", p.get("IpProtocol") or "tcp")
        r.add_query_param("PortRange", pr)
        r.add_query_param("SourceCidrIp", p.get("SourceCidrIp") or "0.0.0.0/0")
        if p.get("NicType"):
            r.add_query_param("NicType", p.get("NicType"))
        try:
            json.loads(client.do_action_with_exception(r))
            print("revoked", pr)
        except Exception as exc:
            print("revoke_fail", pr, type(exc).__name__, str(exc)[:160])


def main() -> int:
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(
        HOST,
        username=USER,
        password=PASSWORD,
        timeout=30,
        allow_agent=PASSWORD is None,
        look_for_keys=PASSWORD is None,
    )

    # Pre-check: Mesh + wxqk must stay up; no active dependency expected
    run(c, "systemctl is-active wxqk; docker inspect -f '{{.State.Health.Status}}' wxqk-meshcentral")
    run(c, "ss -tulpn | grep -E ':(7880|7881|3478|5349)\\b' || echo 'no_old_ports_listening_unexpected'")

    # Stop / disable services
    run(c, "systemctl stop livekit.service || true", check=False)
    run(c, "systemctl disable livekit.service || true", check=False)
    run(c, "systemctl stop coturn.service || true", check=False)
    run(c, "systemctl disable coturn.service || true", check=False)
    run(c, "systemctl reset-failed livekit.service coturn.service 2>/dev/null || true", check=False)

    # Kill leftovers
    run(c, "pkill -f '/opt/livekit/livekit-server' || true", check=False)
    run(c, "pkill -f '/usr/bin/turnserver' || true", check=False)

    # Remove unit + binaries/config/dirs (keep backups under /root/wxqk-old-remote-backup)
    run(c, "mkdir -p /root/wxqk-old-remote-backup-$(date +%Y%m%d)")
    stamp_cmd = "B=/root/wxqk-old-remote-backup-$(date +%Y%m%d); "
    run(
        c,
        stamp_cmd
        + "cp -a /etc/systemd/system/livekit.service $B/ 2>/dev/null || true; "
        "cp -a /opt/livekit $B/ 2>/dev/null || true; "
        "cp -a /etc/turnserver.conf $B/ 2>/dev/null || true; "
        "cp -a /etc/coturn  $B/ 2>/dev/null || true; "
        "echo backed_up",
        check=False,
    )
    run(c, "rm -f /etc/systemd/system/livekit.service")
    run(c, "systemctl daemon-reload")
    run(c, "rm -rf /opt/livekit")
    run(c, "rm -f /etc/turnserver.conf")
    run(c, "apt-get remove -y coturn 2>/dev/null || true; apt-get purge -y coturn 2>/dev/null || true", check=False)

    # Strip LiveKit/TURN env from wxqk.env (do not print secrets)
    run(
        c,
        r"""python3 - <<'PY'
from pathlib import Path
p = Path('/etc/wxqk/wxqk.env')
keys = (
  'LIVEKIT','COTURN','TURN_','WXQK_TURN','WXQK_LIVEKIT','FACAI888_TURN','FACAI888_LIVEKIT',
  'WXQK_WEBRTC','FACAI888_WEBRTC'
)
lines = p.read_text().splitlines()
out=[]; removed=[]
for ln in lines:
    up = ln.split('=',1)[0].upper() if '=' in ln else ''
    if any(up.startswith(k) or k in up for k in keys):
        removed.append(up)
        continue
    out.append(ln)
p.write_text('\n'.join(out)+'\n'); p.chmod(0o600)
print('removed_env_keys', removed)
PY""",
    )

    # UFW: remove old remote ports (keep 80/22/8443/8444/4433/888)
    for rule in (
        "7880/tcp",
        "7881/tcp",
        "3478/tcp",
        "3478/udp",
        "5349/tcp",
        "5349/udp",
        "49152:49200/tcp",
        "49152:49200/udp",
        "49152:49551/tcp",
        "49152:49551/udp",
        "50000:50200/tcp",
        "50000:50200/udp",
    ):
        run(c, f"ufw delete allow {rule} >/dev/null 2>&1 || true", check=False)

    # Aliyun SG
    revoke_sg_ports([7880, 7881, 3478, 5349])

    # Verify survivors
    run(c, "systemctl is-active wxqk nginx docker; docker ps --format '{{.Names}} {{.Status}}'")
    run(c, "systemctl is-enabled livekit.service 2>&1 || true; systemctl is-active livekit.service 2>&1 || true", check=False)
    run(c, "systemctl is-enabled coturn.service 2>&1 || true; systemctl is-active coturn.service 2>&1 || true", check=False)
    run(c, "ps -ef | grep -Ei 'livekit|turnserver|coturn' | grep -v grep || echo 'NO_OLD_REMOTE_PROCS'")
    run(c, "ss -tulpn | grep -E ':(7880|7881|3478|5349)\\b' || echo 'NO_OLD_REMOTE_PORTS'")
    run(c, "ss -tulpn | grep -E ':(8443|8444|4433|4812|80|888)\\b'")
    run(c, "ufw status | grep -Ei '7880|7881|3478|5349|49152|50000|8444|4433|8443' || true")
    run(c, "systemctl restart wxqk && sleep 1 && systemctl is-active wxqk")
    c.close()
    print("OLD_REMOTE_REMOVED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
