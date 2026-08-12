#!/usr/bin/env python3
"""Download Windows agent+msh for existing WXQK Devices mesh (auth via login cookie)."""
from __future__ import annotations

import os
import re
import sys

import paramiko

sys.stdout.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)

REMOTE = """
import json, os, sys, ssl, socket, time, urllib.request, urllib.parse, subprocess, importlib
from pathlib import Path
import http.cookiejar

for ln in Path('/etc/wxqk/wxqk.env').read_text().splitlines():
    if '=' in ln and not ln.startswith('#'):
        k,v=ln.split('=',1); os.environ[k]=v
sys.path.insert(0,'/opt/wxqk')
import meshcentral_client as mc
importlib.reload(mc)
import websocket

mesh_id = (os.environ.get('WXQK_MESH_GROUP') or '').strip()
if not mesh_id:
    # discover via WS
    token = mc.mint_login_token('user//admin', style='control', expire_min=30)
    raw = socket.create_connection(('127.0.0.1', 8444), timeout=20)
    ctx = ssl.create_default_context(); ctx.check_hostname=False
    ctx.load_verify_locations('/etc/nginx/ssl/wxqk-ip.crt')
    ssock = ctx.wrap_socket(raw, server_hostname='120.27.219.138')
    url = 'wss://120.27.219.138:8444/control.ashx?auth=' + token
    ws = websocket.create_connection(url, socket=ssock, timeout=20, origin='https://120.27.219.138:8444')
    ws.send(json.dumps({'action':'meshes','responseid':'m1'}))
    end=time.time()+10
    while time.time()<end:
        ws.settimeout(max(0.2, end-time.time()))
        try: msg=json.loads(ws.recv())
        except Exception: break
        if msg.get('action')=='meshes':
            for x in (msg.get('meshes') or []):
                if x.get('name')=='WXQK Devices':
                    mesh_id=x.get('_id'); break
            break
    ws.close()
if not mesh_id:
    raise SystemExit('no mesh id')
print('MESH', mesh_id[:32]+'...')

# Persist group
p=Path('/etc/wxqk/wxqk.env')
lines=[ln for ln in p.read_text().splitlines() if not ln.startswith('WXQK_MESH_GROUP=')]
lines.append('WXQK_MESH_GROUP='+mesh_id)
p.write_text('\\n'.join(lines)+'\\n'); p.chmod(0o600)

out=Path('/opt/wxqk/meshcentral/agent-staging'); out.mkdir(parents=True, exist_ok=True)

# 1) plain Windows exe without meshid (public)
urllib.request.urlretrieve('http://127.0.0.1:9443/meshagents?id=3', out/'meshagent.exe')
print('EXE', (out/'meshagent.exe').stat().st_size, (out/'meshagent.exe').read_bytes()[:2])

# 2) authenticated downloads via ?login= cookie token through nginx
login = mc.mint_login_token('user//admin', style='cookie', expire_min=30)
qmesh = urllib.parse.quote(mesh_id, safe='')
qlogin = urllib.parse.quote(login, safe='')

ctx = ssl.create_default_context(); ctx.check_hostname=False
ctx.load_verify_locations('/etc/nginx/ssl/wxqk-ip.crt')

def fetch(url, dest):
    # force connect to 127.0.0.1:8444
    req = urllib.request.Request(url, headers={'Host':'120.27.219.138:8444'})
    # custom opener that connects to loopback
    class R(urllib.request.HTTPSHandler):
        def https_open(self, req2):
            return self.do_open(self._conn, req2)
        def _conn(self, host, **kwargs):
            # host will be 120.27.219.138:8444 — redirect to 127.0.0.1
            return ctx.wrap_socket(socket.create_connection(('127.0.0.1', 8444), timeout=60), server_hostname='120.27.219.138')
    opener = urllib.request.build_opener(R())
    with opener.open(req, timeout=120) as resp:
        data = resp.read()
    Path(dest).write_bytes(data)
    return len(data), data[:16]

candidates = [
    f'https://120.27.219.138:8444/meshagents?id=3&meshid={qmesh}&login={qlogin}',
    f'https://120.27.219.138:8444/meshagents?id=3&meshid={qmesh}&login={qlogin}&type=msh',
    f'https://120.27.219.138:8444/?login={qlogin}',
]
for u in candidates[:2]:
    try:
        n, head = fetch(u, out/'dl.bin')
        print('AUTH_DL', n, head)
        if head.startswith(b'MZ'):
            (out/'dl.bin').replace(out/'meshagent.exe'); print('EXE_AUTH_OK')
        text = (out/'dl.bin').read_text(errors='ignore')
        if 'MeshServer=' in text:
            (out/'dl.bin').replace(out/'meshagent.msh'); print('MSH_AUTH_OK')
    except Exception as e:
        print('AUTH_DL_FAIL', e)

# 3) generate msh via MeshCentral common.certificateToHash
gen_js = (
    "const fs=require('fs');"
    "const common=require('/opt/meshcentral/meshcentral/common.js');"
    "const meshid=process.env.MID;"
    "const MeshServer=process.env.MS;"
    "const agentCert=fs.readFileSync('/opt/meshcentral/meshcentral-data/agentserver-cert-public.crt');"
    "let serverid='';"
    "try{serverid=common.certificateToHash(agentCert);}catch(e){console.log('HASHERR='+e)}"
    "if(!serverid){try{serverid=common.certificateToHash(fs.readFileSync('/opt/meshcentral/meshcentral-data/webserver-cert-public.crt'));}catch(e){}}"
    "const lines=['MeshName=WXQK Devices','MeshID='+meshid,'ServerID='+serverid,'MeshServer='+MeshServer];"
    "fs.writeFileSync('/tmp/out.msh', lines.join('\\r\\n')+'\\r\\n');"
    "console.log('sidlen='+(serverid?serverid.length:0)+' midlen='+meshid.length);"
)
Path('/tmp/gen_msh.js').write_text(gen_js)
subprocess.check_call(['docker','cp','/tmp/gen_msh.js','wxqk-meshcentral:/tmp/gen_msh.js'])
leaf = mesh_id.split('//')[-1]
cands=[mesh_id, leaf]
try:
    import base64
    raw=base64.b64decode(leaf+'==', altchars=b'@$')
    cands.append('0x'+raw.hex())
except Exception as e:
    print('b64', e)

if not (out/'meshagent.msh').exists():
    for mid in cands:
        for ms in (
            'wss://120.27.219.138:4433/agent.ashx',
            'wss://120.27.219.138:8444/agent.ashx',
        ):
            outp=subprocess.check_output(
                ['docker','exec','-e','MID='+mid,'-e','MS='+ms,'wxqk-meshcentral','node','/tmp/gen_msh.js'],
                stderr=subprocess.STDOUT, text=True, errors='replace'
            )
            print('GEN', outp.strip())
            subprocess.check_call(['docker','cp','wxqk-meshcentral:/tmp/out.msh', str(out/'meshagent.msh')])
            text=(out/'meshagent.msh').read_text(errors='ignore')
            sid=''
            for ln in text.splitlines():
                if ln.startswith('ServerID='): sid=ln.split('=',1)[1].strip()
            if sid:
                for key in ('MeshName','MeshServer','MeshID','ServerID'):
                    for ln in text.splitlines():
                        if ln.startswith(key+'='):
                            val=ln.split('=',1)[1]
                            print(key, (val[:70]+'...') if len(val)>70 else val)
                break
        else:
            continue
        break

# 4) Prefer official msh from control if available
token = mc.mint_login_token('user//admin', style='control', expire_min=30)
raw = socket.create_connection(('127.0.0.1', 8444), timeout=20)
ctx2 = ssl.create_default_context(); ctx2.check_hostname=False
ctx2.load_verify_locations('/etc/nginx/ssl/wxqk-ip.crt')
ssock = ctx2.wrap_socket(raw, server_hostname='120.27.219.138')
ws = websocket.create_connection(
    'wss://120.27.219.138:8444/control.ashx?auth='+token,
    socket=ssock, timeout=20, origin='https://120.27.219.138:8444'
)
for payload in [
    {'action':'getagentconfig','meshid':mesh_id,'responseid':'g1'},
    {'action':'agentconfig','meshid':mesh_id,'responseid':'g2'},
    {'action':'addagentinvite','meshid':mesh_id,'expire':0,'flags':0,'responseid':'g3'},
]:
    ws.send(json.dumps(payload))
end=time.time()+12
while time.time()<end:
    ws.settimeout(max(0.2, end-time.time()))
    try: msg=json.loads(ws.recv())
    except Exception: break
    print('CTRL', msg.get('action'), list(msg.keys())[:10])
    for k,v in msg.items():
        if isinstance(v,str) and 'MeshServer=' in v:
            (out/'meshagent.msh').write_text(v); print('MSH_FROM_CTRL', k)
try: ws.close()
except Exception: pass

if not (out/'meshagent.msh').exists() or not (out/'meshagent.exe').exists():
    raise SystemExit('staging incomplete')
print('STAGING_OK', sorted(f'{p.name}={p.stat().st_size}' for p in out.iterdir() if p.is_file() and p.suffix in ('.exe','.msh')))
os.system('systemctl restart wxqk')
print('DONE')
"""


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
    with sftp.file("/tmp/wxqk_fetch_agent.py", "w") as f:
        f.write(REMOTE)
    sftp.chmod("/tmp/wxqk_fetch_agent.py", 0o700)
    sftp.close()
    _i, o, e = c.exec_command("python3 /tmp/wxqk_fetch_agent.py", timeout=300, get_pty=True)
    out = o.read().decode("utf-8", "replace")
    code = o.channel.recv_exit_status()
    print(re.sub(r"\b[0-9a-fA-F]{40,}\b", "<hex>", out)[:20000], flush=True)
    c.exec_command("rm -f /tmp/wxqk_fetch_agent.py /tmp/gen_msh.js")
    c.close()
    return code


if __name__ == "__main__":
    raise SystemExit(main())
