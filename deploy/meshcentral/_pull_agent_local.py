#!/usr/bin/env python3
"""Verify msh fields, rehash with ComputeDigesthash if needed, scp agent to local workspace."""
from __future__ import annotations

import os
import re
import sys
from pathlib import Path

import paramiko

sys.stdout.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)

LOCAL_DIR = Path(r"e:\我的软件源码\微信群控\admin-ui\resources\meshcentral")


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

    def run(cmd: str, timeout: int = 120) -> str:
        print("+", cmd[:180], flush=True)
        _i, o, e = c.exec_command(cmd, timeout=timeout, get_pty=True)
        out = o.read().decode("utf-8", "replace")
        print(re.sub(r"\b[0-9a-fA-F]{40,}\b", "<hex>", out)[:8000], flush=True)
        return out

    # Prefer MeshCentral ComputeDigesthash for ServerID
    run(
        "docker exec wxqk-meshcentral node -e \""
        "const fs=require('fs'); const c=require('/opt/meshcentral/meshcentral/common.js');"
        "const pem=fs.readFileSync('/opt/meshcentral/meshcentral-data/agentserver-cert-public.crt');"
        "let sid='';"
        "try{sid=c.ComputeDigesthash(pem);}catch(e){console.log('ERR1',e.message)}"
        "try{if(!sid)sid=c.ComputeDigesthash(pem.toString());}catch(e){console.log('ERR2',e.message)}"
        "console.log('sidlen', sid?sid.length:0);"
        "if(sid){const msh=fs.readFileSync('/tmp/out.msh','utf8');"
        "const lines=msh.split(/\\r?\\n/).map(l=>l.startsWith('ServerID=')?('ServerID='+sid):l);"
        "fs.writeFileSync('/tmp/out2.msh', lines.join('\\r\\n'));"
        "console.log('UPDATED');}"
        "\""
    )
    run(
        "python3 - <<'PY'\n"
        "from pathlib import Path\n"
        "p=Path('/opt/wxqk/meshcentral/agent-staging/meshagent.msh')\n"
        "text=p.read_text(errors='ignore')\n"
        "for ln in text.splitlines():\n"
        "  if not ln or '=' not in ln: continue\n"
        "  k,v=ln.split('=',1)\n"
        "  if k=='ServerID': print(f'{k}=len:{len(v)} prefix:{v[:12]}...')\n"
        "  elif k=='MeshID': print(f'{k}=len:{len(v)} prefix:{v[:20]}...')\n"
        "  elif k=='MeshServer': print(f'{k}={v}')\n"
        "  else: print(f'{k}={v}')\n"
        "need=['MeshName','MeshID','ServerID','MeshServer']\n"
        "keys={ln.split('=',1)[0] for ln in text.splitlines() if '=' in ln}\n"
        "print('MISSING', [k for k in need if k not in keys])\n"
        "print('POINTS_PROD', '203.0.113.10' in text)\n"
        "PY"
    )

    # health: mesh HTTPS + wxqk active + docker
    run(
        "curl -skI --resolve 203.0.113.10:8444:127.0.0.1 https://203.0.113.10:8444/ | head -n 12; "
        "cd /opt/wxqk/meshcentral && docker compose ps --format '{{.Name}} {{.Status}}'; "
        "systemctl is-active wxqk docker; "
        "python3 - <<'PY'\n"
        "from pathlib import Path\n"
        "keys=[]\n"
        "for ln in Path('/etc/wxqk/wxqk.env').read_text().splitlines():\n"
        "  if ln.startswith('WXQK_MESH_'):\n"
        "    k=ln.split('=',1)[0]\n"
        "    if 'KEY' in k or 'SECRET' in k: keys.append(k+'=<redacted>')\n"
        "    else: keys.append(ln if 'GROUP' not in k else k+'=<set>')\n"
        "print('\\n'.join(keys))\n"
        "PY"
    )

    # backup
    run(
        "stamp=$(date +%Y%m%d-%H%M%S); cd /opt/wxqk/meshcentral && "
        "mkdir -p backups/wxqk-mesh-$stamp && cp -a config.json .env data files agent-staging backups/wxqk-mesh-$stamp/ && "
        "ls backups/wxqk-mesh-$stamp && du -sh backups/wxqk-mesh-$stamp"
    )

    LOCAL_DIR.mkdir(parents=True, exist_ok=True)
    sftp = c.open_sftp()
    for name in ("meshagent.exe", "meshagent.msh"):
        remote = f"/opt/wxqk/meshcentral/agent-staging/{name}"
        local = LOCAL_DIR / name
        print(f"sftp {remote} -> {local}", flush=True)
        sftp.get(remote, str(local))
        print("local size", local.stat().st_size, flush=True)
    sftp.close()
    c.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
