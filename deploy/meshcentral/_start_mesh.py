#!/usr/bin/env python3
"""Start existing MeshCentral stack and report health (no secrets printed)."""
from __future__ import annotations

import os
import sys
import time

import paramiko

sys.stdout.reconfigure(line_buffering=True)


def main() -> int:
    host = os.environ["WXQK_SSH_HOST"]
    password = os.environ["WXQK_SSH_PASSWORD"]
    user = os.environ.get("WXQK_SSH_USER", "root")
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    print(f"connecting to {host}…", flush=True)
    c.connect(host, username=user, password=password, timeout=30, allow_agent=False, look_for_keys=False)

    def run(cmd: str, timeout: int = 600, check: bool = True) -> tuple[int, str]:
        print(f"+ {cmd}", flush=True)
        _i, o, e = c.exec_command(cmd, timeout=timeout, get_pty=True)
        out = o.read().decode("utf-8", "replace")
        err = e.read().decode("utf-8", "replace")
        code = o.channel.recv_exit_status()
        text = (out or "") + (("\n" + err) if err and err not in out else "")
        if text.strip():
            print(text[:12000], flush=True)
        if check and code != 0:
            raise SystemExit(f"failed ({code}): {cmd}")
        return code, text

    run("cd /opt/wxqk/meshcentral && docker compose config >/tmp/mesh-compose-ok.yml")
    print("pulling image (may take several minutes)…", flush=True)
    code, text = run(
        "cd /opt/wxqk/meshcentral && docker compose pull 2>&1",
        timeout=1200,
        check=False,
    )
    if code != 0:
        print("pull failed; trying docker pull directly…", flush=True)
        run("docker pull ghcr.io/ylianst/meshcentral:1.2.4 2>&1", timeout=1200)
    run("cd /opt/wxqk/meshcentral && docker compose up -d 2>&1", timeout=300)
    time.sleep(15)
    run("cd /opt/wxqk/meshcentral && docker compose ps 2>&1", check=False)
    run("cd /opt/wxqk/meshcentral && docker compose logs --tail=100 2>&1", check=False)
    run("ss -tulpn | egrep ':(8444|9443|9080|4433)\\b' || true", check=False)
    run("curl -skI https://127.0.0.1:8444/ | head -n 25", check=False)
    run("curl -sI http://127.0.0.1:9080/ | head -n 15", check=False)
    run("curl -skI https://120.27.219.138:8444/ | head -n 25", check=False)
    c.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
