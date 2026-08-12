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
cmd = (
    "docker exec wxqk-meshcentral sh -c "
    "\"grep -Rn invalidorigin /opt/meshcentral/meshcentral 2>/dev/null | head -n 30; "
    "grep -Rni origincheck /opt/meshcentral/meshcentral 2>/dev/null | head -n 30\""
)
_i, o, e = c.exec_command(cmd, timeout=90, get_pty=True)
print(o.read().decode("utf-8", "replace")[:15000])
c.close()
