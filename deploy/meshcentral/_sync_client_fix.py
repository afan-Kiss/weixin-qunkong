#!/usr/bin/env python3
"""Push meshcentral_client.py + wire TLS CA; verify control sync."""
from __future__ import annotations

import os
import re
import sys
from pathlib import Path

import paramiko

sys.stdout.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
LOCAL = Path(r"e:\我的软件源码\微信群控\server\wxqk\meshcentral_client.py")


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
    sftp = c.open_sftp()
    sftp.put(str(LOCAL), "/opt/wxqk/meshcentral_client.py")
    sftp.close()

    # upsert TLS CA + keep mesh env
    remote = r'''
from pathlib import Path
p = Path('/etc/wxqk/wxqk.env')
lines = p.read_text().splitlines() if p.exists() else []
kv = {
  'WXQK_MESH_TLS_CA': '/etc/nginx/ssl/wxqk-ip.crt',
  'WXQK_MESH_INTERNAL_URL': 'https://120.27.219.138:8444',
  'WXQK_MESH_WS_LOCAL_HOST': '127.0.0.1',
}
out = []
seen = set()
for ln in lines:
    k = ln.split('=',1)[0] if '=' in ln else ''
    if k in kv:
        out.append(k + '=' + kv[k]); seen.add(k)
    else:
        out.append(ln)
for k,v in kv.items():
    if k not in seen:
        out.append(k + '=' + v)
p.write_text('\n'.join(out) + '\n'); p.chmod(0o600)
print('TLS_CA_WIRED')
'''
    sftp = c.open_sftp()
    with sftp.file("/tmp/wire_tls_ca.py", "w") as f:
        f.write(remote)
    sftp.close()
    def run(cmd: str, timeout: int = 120) -> str:
        print("+", cmd[:160], flush=True)
        _i, o, e = c.exec_command(cmd, timeout=timeout, get_pty=True)
        out = o.read().decode("utf-8", "replace")
        print(re.sub(r"\b[0-9a-fA-F]{40,}\b", "<hex>", out)[:8000], flush=True)
        return out

    run("python3 /tmp/wire_tls_ca.py && rm -f /tmp/wire_tls_ca.py && systemctl restart wxqk && sleep 3 && systemctl is-active wxqk")
    run(
        "python3 - <<'PY'\n"
        "import os,sys\n"
        "from pathlib import Path\n"
        "for ln in Path('/etc/wxqk/wxqk.env').read_text().splitlines():\n"
        "  if '=' in ln and not ln.startswith('#'):\n"
        "    k,v=ln.split('=',1); os.environ[k]=v\n"
        "sys.path.insert(0,'/opt/wxqk')\n"
        "import importlib, meshcentral_client as mc\n"
        "importlib.reload(mc)\n"
        "print('enabled', mc.is_enabled())\n"
        "print('url', mc.public_url())\n"
        "print('token_len', len(mc.mint_login_token('user//admin', style='cookie', expire_min=5)))\n"
        "synced = mc.sync_nodes_via_control()\n"
        "print('sync', {k:synced.get(k) for k in ('ok','code','message')})\n"
        "print('meshes', len(synced.get('meshes') or []), 'nodes', len(synced.get('nodes') or []))\n"
        "names=[m.get('name') for m in (synced.get('meshes') or [])]\n"
        "print('mesh_names', names)\n"
        "PY"
    )
    c.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
