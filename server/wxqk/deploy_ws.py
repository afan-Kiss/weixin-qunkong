#!/usr/bin/env python3
"""Deploy siren server + wsutil + nginx websocket headers for /发财888 and /siren."""
from __future__ import annotations

import time
import os
from pathlib import Path

import paramiko
from ssh_host_key import configure_ssh_client

HOST = os.environ.get("WXQK_SSH_HOST", "47.108.21.50")
PASSWORD = os.environ.get("WXQK_SSH_PASSWORD") or None
REMOTE = "/opt/betclient-siren"
HERE = Path(__file__).resolve().parent


def main() -> None:
    c = paramiko.SSHClient()
    configure_ssh_client(c)
    c.connect(HOST, username=os.environ.get("WXQK_SSH_USER", "root"), password=PASSWORD, timeout=20, allow_agent=PASSWORD is None, look_for_keys=PASSWORD is None)

    def run(cmd: str) -> str:
        _, stdout, stderr = c.exec_command(cmd, timeout=90)
        out = stdout.read().decode("utf-8", "replace")
        err = stderr.read().decode("utf-8", "replace")
        print("$", cmd)
        if out.strip():
            print(out[:2500])
        if err.strip():
            print("ERR", err[:1200])
        return out

    sftp = c.open_sftp()
    for name in ("server.py", "wsutil.py", "admin_ui.py"):
        local = HERE / name
        if local.exists():
            sftp.put(str(local), f"{REMOTE}/{name}")
    sftp.close()

    run("systemctl restart betclient-siren.service")
    time.sleep(1)
    run("systemctl --no-pager is-active betclient-siren.service")
    run("curl -sS -o /dev/null -w '%{http_code}\\n' http://127.0.0.1:4810/")
    run("curl -sS -o /dev/null -w '%{http_code}\\n' -H 'Host: xiangyuzhubao.xyz' https://127.0.0.1/siren/ -k")
    run(
        "curl -sS -o /dev/null -w '%{http_code}\\n' --path-as-is "
        "-H 'Host: xiangyuzhubao.xyz' https://127.0.0.1/%E5%8F%91%E8%B4%A2888/ -k"
    )
    c.close()
    print("deploy ok")


if __name__ == "__main__":
    main()
