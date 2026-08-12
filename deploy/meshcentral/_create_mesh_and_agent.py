#!/usr/bin/env python3
"""Create WXQK Devices mesh via control.ashx and fetch Windows agent+msh to server staging."""
from __future__ import annotations

import json
import os
import re
import sys
import time
from pathlib import Path

import paramiko

sys.stdout.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)

REMOTE_SCRIPT = r'''
import json, os, ssl, sys, time, urllib.request
from pathlib import Path

# load env
for ln in Path('/etc/wxqk/wxqk.env').read_text().splitlines():
    if '=' in ln and not ln.startswith('#'):
        k,v=ln.split('=',1)
        os.environ.setdefault(k,v)
sys.path.insert(0,'/opt/wxqk')
import meshcentral_client as mc

try:
    import websocket
except ImportError:
    os.system('pip3 install -q websocket-client')
    import websocket

token = mc.mint_login_token('user//admin', style='control')
# TlsOffload: host:9443 is plain HTTP to MeshCentral :443
url = 'ws://127.0.0.1:9443/control.ashx?auth=' + token
print('WS_CONNECT')
ws = websocket.create_connection(url, timeout=20)
ws.send(json.dumps({"action":"meshes","responseid":"m1"}))
deadline=time.time()+15
meshes=[]
while time.time()<deadline:
    ws.settimeout(max(0.2, deadline-time.time()))
    try:
        raw=ws.recv()
    except Exception:
        break
    try:
        msg=json.loads(raw)
    except Exception:
        continue
    if msg.get('action')=='meshes':
        meshes=msg.get('meshes') or []
        break
print('MESH_COUNT_BEFORE', len(meshes))
existing=None
for m in meshes:
    if str(m.get('name') or '') == 'WXQK Devices':
        existing=m
        break
if existing is None:
    ws.send(json.dumps({
        "action":"createmesh",
        "meshname":"WXQK Devices",
        "meshtype":2,
        "desc":"wxqk managed Windows devices",
        "responseid":"c1",
    }))
    deadline=time.time()+15
    while time.time()<deadline:
        ws.settimeout(max(0.2, deadline-time.time()))
        try:
            raw=ws.recv()
        except Exception:
            break
        try:
            msg=json.loads(raw)
        except Exception:
            continue
        print('MSG', msg.get('action'), msg.get('responseid'), 'ok' if msg.get('result')=='ok' else '')
        if msg.get('action') in ('createmesh','meshes') or msg.get('responseid')=='c1':
            # refresh
            break
    ws.send(json.dumps({"action":"meshes","responseid":"m2"}))
    deadline=time.time()+15
    meshes=[]
    while time.time()<deadline:
        ws.settimeout(max(0.2, deadline-time.time()))
        try:
            raw=ws.recv()
        except Exception:
            break
        try:
            msg=json.loads(raw)
        except Exception:
            continue
        if msg.get('action')=='meshes':
            meshes=msg.get('meshes') or []
            break
    for m in meshes:
        if str(m.get('name') or '') == 'WXQK Devices':
            existing=m
            break
ws.close()
if not existing:
    print('CREATE_FAIL meshes=', json.dumps([{k:m.get(k) for k in ('_id','name','type') if k in m} for m in meshes]))
    raise SystemExit(2)
mesh_id = existing.get('_id') or existing.get('meshid') or ''
print('MESH_ID_PREFIX', str(mesh_id)[:24]+'...')
print('MESH_NAME', existing.get('name'))

# Persist group id into wxqk.env
p=Path('/etc/wxqk/wxqk.env')
lines=[ln for ln in p.read_text().splitlines() if not ln.startswith('WXQK_MESH_GROUP=')]
lines.append('WXQK_MESH_GROUP='+str(mesh_id))
p.write_text('\\n'.join(lines)+'\\n'); p.chmod(0o600)
print('GROUP_WIRED')

# Download Windows x64 agent (id=6 typical) with meshid into staging
out=Path('/opt/wxqk/meshcentral/agent-staging')
out.mkdir(parents=True, exist_ok=True)
# try several agent ids
picked=None
for aid in (6,4,3,5,7):
    url=f'http://127.0.0.1:9443/meshagents?id={aid}&meshid={mesh_id}'
    dest=out/f'agent-{aid}.bin'
    try:
        urllib.request.urlretrieve(url, dest)
    except Exception as e:
        print('DL_FAIL', aid, e)
        continue
    size=dest.stat().st_size
    print('DL', aid, size)
    if size > 100_000:
        picked=aid
        dest.rename(out/'meshagent.exe')
        break
if not picked:
    raise SystemExit('agent exe download failed')

# .msh: MeshCentral often serves via meshagents?id=...&meshid=...&installflags=0 or separate
# Also try /meshsettings or invite. Common: same URL with Accept or .msh extension path.
msh_candidates=[
    f'http://127.0.0.1:9443/meshagents?id={picked}&meshid={mesh_id}&meshcmd=1',
    f'http://127.0.0.1:9443/meshagents?id={picked}&meshid={mesh_id}',
]
# Better: ask control for invite / agent download link
# Generate .msh via known MeshCentral format using server cert ServerID if needed.

# Try downloading msh from agentscript or meshagent.ashx
for u in [
    f'http://127.0.0.1:9443/meshagents?id={picked}&meshid={mesh_id}&binary=0',
    f'http://127.0.0.1:9443/agentinvite?meshid={mesh_id}',
]:
    try:
        req=urllib.request.Request(u)
        with urllib.request.urlopen(req, timeout=30) as resp:
            data=resp.read()
            ctype=resp.headers.get('content-type','')
            print('TRY', u.split('?')[0], 'ctype', ctype, 'len', len(data), 'head', data[:40])
            if b'MeshServer=' in data or b'MeshID=' in data:
                (out/'meshagent.msh').write_bytes(data)
                print('MSH_OK')
                break
    except Exception as e:
        print('MSH_TRY_FAIL', e)

if not (out/'meshagent.msh').exists():
    # Use websocket to request agentconfig / invitecode
    token = mc.mint_login_token('user//admin', style='control')
    url = 'ws://127.0.0.1:9443/control.ashx?auth=' + token
    ws = websocket.create_connection(url, timeout=20)
    for action in (
        {"action":"message","nodeid":None},
    ):
        pass
    # MeshCentral: action getagentconfig or downloadagentconfigfile
    for payload in [
        {"action":"getagentconfig","meshid":mesh_id,"responseid":"g1"},
        {"action":"downloadagentconfig","meshid":mesh_id,"responseid":"g2"},
        {"action":"agentconfig","meshid":mesh_id,"responseid":"g3"},
        {"action":"createinvite","meshid":mesh_id,"flags":0,"expire":0,"responseid":"g4"},
    ]:
        ws.send(json.dumps(payload))
    deadline=time.time()+20
    while time.time()<deadline:
        ws.settimeout(max(0.2, deadline-time.time()))
        try:
            raw=ws.recv()
        except Exception:
            break
        try:
            msg=json.loads(raw)
        except Exception:
            continue
        act=msg.get('action')
        print('CTRL', act, list(msg.keys())[:12])
        for k in ('config','msh','data','url','link','result'):
            v=msg.get(k)
            if isinstance(v,str) and ('MeshServer=' in v or 'MeshID=' in v):
                (out/'meshagent.msh').write_text(v)
                print('MSH_FROM', act)
                break
            if isinstance(v,dict) and v.get('msh'):
                (out/'meshagent.msh').write_text(str(v.get('msh')))
                print('MSH_FROM_DICT', act)
                break
        if (out/'meshagent.msh').exists():
            break
    ws.close()

if (out/'meshagent.msh').exists():
    text=(out/'meshagent.msh').read_text(errors='ignore')
    for key in ('MeshServer','MeshID','ServerID'):
        for ln in text.splitlines():
            if ln.startswith(key+'='):
                val=ln.split('=',1)[1].strip()
                print(key, val[:48]+('...' if len(val)>48 else ''))
                break
    print('STAGING_OK', sorted(p.name for p in out.iterdir()))
else:
    print('STAGING_PARTIAL exe_ok msh_missing')
    raise SystemExit(3)
'''


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
    with sftp.file("/tmp/wxqk_create_mesh.py", "w") as f:
        f.write(REMOTE_SCRIPT)
    sftp.chmod("/tmp/wxqk_create_mesh.py", 0o700)
    sftp.close()
    print("+ run create mesh script", flush=True)
    _i, o, e = c.exec_command("python3 /tmp/wxqk_create_mesh.py", timeout=180, get_pty=True)
    out = o.read().decode("utf-8", "replace")
    code = o.channel.recv_exit_status()
    safe = re.sub(r"\b[0-9a-fA-F]{40,}\b", "<hex>", out)
    print(safe[:15000], flush=True)
    c.exec_command("rm -f /tmp/wxqk_create_mesh.py")
    c.close()
    return code


if __name__ == "__main__":
    raise SystemExit(main())
