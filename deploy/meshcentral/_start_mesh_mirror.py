#!/usr/bin/env python3
"""Kill stuck pulls, pull MeshCentral via China-friendly mirror, retag, start."""
from __future__ import annotations

import os
import sys
import time

import paramiko

sys.stdout.reconfigure(line_buffering=True)


def main() -> int:
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(
        os.environ["WXQK_SSH_HOST"],
        username=os.environ.get("WXQK_SSH_USER", "root"),
        password=os.environ["WXQK_SSH_PASSWORD"],
        timeout=30,
        allow_agent=False,
        look_for_keys=False,
    )

    def run(cmd: str, timeout: int = 900, check: bool = True) -> tuple[int, str]:
        print(f"+ {cmd}", flush=True)
        _i, o, e = c.exec_command(cmd, timeout=timeout, get_pty=True)
        out = o.read().decode("utf-8", "replace")
        code = o.channel.recv_exit_status()
        if out.strip():
            print(out[:15000], flush=True)
        if check and code != 0:
            raise SystemExit(f"fail {code}")
        return code, out

    # Stop duplicate compose pulls / hung sessions
    run(
        "pkill -f 'docker compose pull' || true; pkill -f 'docker-compose compose pull' || true; "
        "sleep 2; ps aux | egrep 'compose pull|docker pull' | grep -v egrep || echo no-pullers",
        check=False,
    )

    # Prefer mirror pull then retag to official name used by compose
    mirrors = [
        "ghcr.nju.edu.cn/ylianst/meshcentral:1.2.4",
        "ghcr.m.daocloud.io/ylianst/meshcentral:1.2.4",
        "ghcr.io/ylianst/meshcentral:1.2.4",
    ]
    pulled = False
    for img in mirrors:
        print(f"trying {img}", flush=True)
        code, _ = run(f"docker pull {img} 2>&1", timeout=1200, check=False)
        if code == 0:
            if img != "ghcr.io/ylianst/meshcentral:1.2.4":
                run(f"docker tag {img} ghcr.io/ylianst/meshcentral:1.2.4")
            pulled = True
            break
        print(f"mirror failed: {img}", flush=True)

    if not pulled:
        raise SystemExit("all image mirrors failed")

    run("docker images | head -n 10", check=False)
    run("cd /opt/wxqk/meshcentral && docker compose up -d 2>&1", timeout=300)
    for i in range(18):
        code, out = run(
            "docker inspect -f '{{.State.Status}} {{.State.Health.Status}}' wxqk-meshcentral 2>/dev/null || echo missing",
            check=False,
            timeout=60,
        )
        if "healthy" in out or ("running" in out and "starting" not in out and i > 6):
            break
        time.sleep(10)
    run("cd /opt/wxqk/meshcentral && docker compose ps 2>&1", check=False)
    run("cd /opt/wxqk/meshcentral && docker compose logs --tail=120 2>&1", check=False)
    run("ss -tulpn | egrep ':(8444|9443|9080|4433)\\b' || true", check=False)
    run("curl -skI https://127.0.0.1:8444/ | head -n 25", check=False)
    run("curl -sI http://127.0.0.1:9080/ | head -n 20", check=False)
    run("curl -skI https://203.0.113.10:8444/ | head -n 25", check=False)
    c.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
