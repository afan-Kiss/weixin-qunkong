#!/usr/bin/env python3
from __future__ import annotations

import os
import sys
import time

import paramiko

sys.stdout.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)


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

    def run(cmd: str, timeout: int = 300, check: bool = True) -> tuple[int, str]:
        print(f"+ {cmd}", flush=True)
        _i, o, e = c.exec_command(cmd, timeout=timeout, get_pty=True)
        raw = o.read()
        out = raw.decode("utf-8", "replace")
        # strip braille spinners / ansi for Windows console
        safe = "".join(ch for ch in out if ord(ch) < 0x2800 or ord(ch) > 0x28FF)
        code = o.channel.recv_exit_status()
        if safe.strip():
            print(safe[:12000], flush=True)
        if check and code != 0:
            raise SystemExit(f"fail {code}")
        return code, safe

    run("cd /opt/wxqk/meshcentral && DOCKER_CLI_HINTS=false docker compose up -d 2>&1 | sed 's/\\x1b\\[[0-9;]*[a-zA-Z]//g'", check=False)
    time.sleep(8)
    for i in range(20):
        _, out = run(
            "docker inspect -f '{{.State.Status}}/{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' wxqk-meshcentral 2>/dev/null || echo missing",
            check=False,
        )
        if "running/healthy" in out:
            break
        if "running/" in out and i >= 10:
            break
        time.sleep(8)

    run("cd /opt/wxqk/meshcentral && docker compose ps --format json 2>/dev/null | head -c 2000; echo; docker compose ps 2>&1 | cat -v", check=False)
    run("cd /opt/wxqk/meshcentral && docker compose logs --no-color --tail=150 2>&1 | cat -v", check=False)
    run("ss -tulpn | egrep ':(8444|9443|9080|4433)\\b' || true", check=False)
    run("curl -skI https://127.0.0.1:8444/ | head -n 25", check=False)
    run("curl -sI http://127.0.0.1:9080/ | head -n 20", check=False)
    run("curl -skI https://203.0.113.10:8444/ | head -n 25", check=False)
    # verify webRTC false in running config
    run("python3 -c \"import json;print(json.load(open('/opt/wxqk/meshcentral/config.json'))['settings']['webRTC'])\"", check=False)
    c.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
