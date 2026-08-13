#!/usr/bin/env python3
"""Find MeshCentral entrypoint, rotate admin bootstrap file, probe agent paths."""
from __future__ import annotations

import os
import secrets
import sys

import paramiko

sys.stdout.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)


def main() -> int:
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(
        os.environ["WXQK_SSH_HOST"],
        username="root",
        password=os.environ["WXQK_SSH_PASSWORD"],
        timeout=30,
        allow_agent=False,
        look_for_keys=False,
    )

    def run(cmd: str, timeout: int = 180, check: bool = True) -> tuple[int, str]:
        print(f"+ {cmd[:200]}", flush=True)
        _i, o, e = c.exec_command(cmd, timeout=timeout, get_pty=True)
        out = o.read().decode("utf-8", "replace")
        code = o.channel.recv_exit_status()
        safe = "".join(ch for ch in out if not (0x2800 <= ord(ch) <= 0x28FF))
        # never print password= lines
        lines = []
        for ln in safe.splitlines():
            if "password=" in ln.lower() or "pass " in ln.lower() and "--pass" in ln.lower():
                lines.append("[redacted line]")
            else:
                lines.append(ln)
        print("\n".join(lines)[:12000], flush=True)
        if check and code != 0:
            raise SystemExit(f"fail {code}")
        return code, out

    run(
        "docker exec wxqk-meshcentral sh -c '"
        "pwd; ls -la /opt/meshcentral | head; "
        "ls -la /opt/meshcentral/node_modules 2>/dev/null | head; "
        "find /opt/meshcentral -maxdepth 3 -name meshcentral.js 2>/dev/null; "
        "find /opt/meshcentral -maxdepth 4 -name \"*.exe\" 2>/dev/null | head -n 40; "
        "ps aux | head -n 5; "
        "ls /proc/1/cmdline | tr \"\\0\" \" \"; echo; "
        "tr \"\\0\" \" \" < /proc/1/cmdline; echo"
        "'",
        check=False,
    )

    # Rotate bootstrap password file (do not echo password)
    new_pass = secrets.token_urlsafe(28)
    sftp = c.open_sftp()
    with sftp.file("/opt/wxqk/meshcentral/ADMIN_BOOTSTRAP.txt", "w") as f:
        f.write(
            "# MeshCentral bootstrap — server only — chmod 600\n"
            "user=admin\n"
            "userid=user//admin\n"
            f"password={new_pass}\n"
            "url=https://203.0.113.10:8444\n"
            "note=first web signup becomes site admin if no users yet\n"
        )
    sftp.chmod("/opt/wxqk/meshcentral/ADMIN_BOOTSTRAP.txt", 0o600)
    sftp.close()
    print("[MESH] rotated ADMIN_BOOTSTRAP.txt (password not printed)", flush=True)

    # Attempt createaccount via discovered entry
    # Write password into a file inside container via docker cp to avoid argv logging
    sftp = c.open_sftp()
    with sftp.file("/tmp/mc_admin_pass.txt", "w") as f:
        f.write(new_pass)
    sftp.chmod("/tmp/mc_admin_pass.txt", 0o600)
    sftp.close()
    run("docker cp /tmp/mc_admin_pass.txt wxqk-meshcentral:/tmp/mc_admin_pass.txt && shred -u /tmp/mc_admin_pass.txt || rm -f /tmp/mc_admin_pass.txt")
    run(
        "docker exec wxqk-meshcentral sh -c '"
        "PASS=$(cat /tmp/mc_admin_pass.txt); rm -f /tmp/mc_admin_pass.txt; "
        "ENTRY=$(find /opt/meshcentral -maxdepth 3 -name meshcentral.js | head -n1); "
        "echo ENTRY=$ENTRY; "
        "if [ -n \"$ENTRY\" ]; then "
        "  node \"$ENTRY\" --createaccount admin --pass \"$PASS\" 2>&1 | sed \"s/$PASS/<redacted>/g\"; "
        "else "
        "  ls -la /opt/meshcentral; "
        "fi"
        "'",
        check=False,
        timeout=180,
    )

    # Public HTTPS via Host header on loopback (avoid hairpin hang)
    run(
        "curl -skI --resolve 203.0.113.10:8444:127.0.0.1 https://203.0.113.10:8444/ | head -n 20",
        check=False,
    )
    # mesh health needs auth cookie — check unauthenticated code path vs with fake
    run(
        "curl -sk https://127.0.0.1:8443/wxqk/api/mesh/health; echo; "
        "python3 - <<'PY'\n"
        "import os,json\n"
        "from pathlib import Path\n"
        "# show mesh env presence only\n"
        "text=Path('/etc/wxqk/wxqk.env').read_text()\n"
        "keys=[ln.split('=',1)[0] for ln in text.splitlines() if ln.startswith('WXQK_MESH_')]\n"
        "print('mesh_env_keys', keys)\n"
        "PY",
        check=False,
    )
    # Does server.py import mesh_api?
    run("grep -n mesh_api /opt/wxqk/server.py | head; grep -n MESH_ENABLED /opt/wxqk/*.py | head", check=False)
    run("docker compose -f /opt/wxqk/meshcentral/docker compose ps 2>/dev/null; cd /opt/wxqk/meshcentral && docker compose ps", check=False)
    c.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
