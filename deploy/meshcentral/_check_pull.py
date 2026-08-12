#!/usr/bin/env python3
import os
import paramiko

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
for cmd in [
    "ps aux | egrep 'docker|containerd|pull' | grep -v egrep | head -n 30",
    "docker images | head -n 20",
    "ls -la /var/lib/docker/tmp 2>/dev/null | head || true",
    "timeout 20 docker pull ghcr.io/ylianst/meshcentral:1.2.4 2>&1 | tail -n 30 || echo PULL_TIMEOUT_OR_FAIL",
]:
    print("====", cmd[:80], flush=True)
    _i, o, e = c.exec_command(cmd, timeout=60)
    print(o.read().decode()[:4000], flush=True)
    err = e.read().decode()[:1000]
    if err.strip():
        print("ERR", err[:800], flush=True)
c.close()
