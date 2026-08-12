#!/usr/bin/env python3
import os
import paramiko

def run(c, cmd):
    print("====", cmd[:90])
    _i, o, e = c.exec_command(cmd, timeout=120)
    print(o.read().decode("utf-8", errors="replace")[:8000])
    err = e.read().decode("utf-8", errors="replace")[:2000]
    if err.strip():
        print("ERR", err[:1500])

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
    "cat /opt/wxqk/meshcentral/docker-compose.yml",
    "python3 - <<'PY'\nfrom pathlib import Path\np=Path('/opt/wxqk/meshcentral/.env')\nfor ln in p.read_text().splitlines():\n  if any(x in ln.upper() for x in ['KEY','SECRET','PASSWORD','TOKEN']):\n    k=ln.split('=',1)[0]; print(k+'=<redacted>')\n  else:\n    print(ln)\nPY",
    "cat /opt/wxqk/meshcentral/config.json",
    "cat /etc/nginx/sites-enabled/wxqk-mesh-8444.conf",
    "docker ps -a --format 'table {{.Names}}\\t{{.Image}}\\t{{.Status}}\\t{{.Ports}}'",
    "ls -la /opt/wxqk/meshcentral/data /opt/wxqk/meshcentral/files /opt/wxqk/meshcentral/backups",
    "test -f /etc/wxqk/wxqk.env && python3 - <<'PY'\nfrom pathlib import Path\np=Path('/etc/wxqk/wxqk.env')\nfor ln in p.read_text().splitlines():\n  if not ln.strip() or ln.strip().startswith('#'): continue\n  k=ln.split('=',1)[0]\n  if any(x in k.upper() for x in ['KEY','SECRET','PASSWORD','TOKEN','PUBLISH']):\n    print(k+'=<redacted>')\n  else:\n    print(ln)\nPY",
]:
    run(c, cmd)
c.close()
