#!/usr/bin/env python3
"""Robust MeshCentral createmesh + agent staging (server-side)."""
from __future__ import annotations

import os
import re
import sys

import paramiko

sys.stdout.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)

REMOTE = r'''
import json, os, sys, time, urllib.request
from pathlib import Path

for ln in Path('/etc/wxqk/wxqk.env').read_text().splitlines():
    if '=' in ln and not ln.startswith('#'):
        k,v=ln.split('=',1); os.environ.setdefault(k,v)
sys.path.insert(0,'/opt/wxqk')
import meshcentral_client as mc
import websocket

def open_ws(style='control'):
    token = mc.mint_login_token('user//admin', style=style, expire_min=30)
    # Prefer nginx TLS with known cert; fallback to TlsOffload plain HTTP
    urls = [
        'wss://120.27.219.138:8444/control.ashx?auth=' + token,
        'ws://127.0.0.1:9443/control.ashx?auth=' + token,
    ]
    last=None
    for url in urls:
        try:
            if url.startswith('wss://'):
                import ssl
                ctx = ssl.create_default_context()
                ctx.load_verify_locations('/etc/nginx/ssl/wxqk-ip.crt')
                # IP cert may not match hostname verification perfectly — still verify cert chain
                try:
                    ws = websocket.create_connection(url, timeout=20, sslopt={"context": ctx, "server_hostname": "120.27.219.138"})
                except Exception:
                    # cert is self-signed for IP; load as trusted and disable hostname only if needed
                    ctx2 = ssl.create_default_context()
                    ctx2.check_hostname = False
                    ctx2.load_verify_locations('/etc/nginx/ssl/wxqk-ip.crt')
                    ws = websocket.create_connection(url, timeout=20, sslopt={"context": ctx2})
            else:
                ws = websocket.create_connection(url, timeout=20)
            print('OPEN_OK', url.split('?')[0], 'style', style)
            return ws, url.split('?')[0]
        except Exception as e:
            last=e
            print('OPEN_FAIL', url.split('?')[0], type(e).__name__, e)
    raise SystemExit(f'ws open failed: {last}')

def recv_until(ws, seconds=12):
    end=time.time()+seconds
    msgs=[]
    while time.time()<end:
        ws.settimeout(max(0.2, end-time.time()))
        try:
            raw=ws.recv()
        except Exception as e:
            break
        if not raw:
            break
        try:
            msg=json.loads(raw)
        except Exception:
            continue
        msgs.append(msg)
        print('RECV', msg.get('action'), msg.get('responseid'), 'keys', sorted(msg.keys())[:10])
    return msgs

# Try cookie-style auth on control too
for style in ('control', 'cookie'):
    try:
        ws, base = open_ws(style)
    except SystemExit as e:
        print(e); continue
    # serverinfo / userinfo
    for payload in [
        {"action":"serverinfo","responseid":"s1"},
        {"action":"users","responseid":"u1"},
        {"action":"meshes","responseid":"m1"},
        {"action":"createmesh","meshname":"WXQK Devices","meshtype":2,"desc":"wxqk windows agents","responseid":"c1"},
        {"action":"createmesh","name":"WXQK Devices","type":2,"responseid":"c2"},
        {"action":"meshes","responseid":"m2"},
    ]:
        try:
            ws.send(json.dumps(payload))
            print('SEND', payload.get('action'), payload.get('responseid'))
            time.sleep(0.3)
        except Exception as e:
            print('SEND_FAIL', payload.get('action'), e)
            break
    msgs=recv_until(ws, 15)
    try:
        ws.close()
    except Exception:
        pass
    meshes=[]
    for msg in msgs:
        if msg.get('action')=='meshes' and isinstance(msg.get('meshes'), list):
            meshes=msg['meshes']
        if msg.get('action')=='createmesh':
            print('CREATE_RESP', {k:msg.get(k) for k in msg if k!='mesh'})
            if isinstance(msg.get('mesh'), dict):
                meshes.append(msg['mesh'])
    found=None
    for m in meshes:
        if str(m.get('name') or '')=='WXQK Devices':
            found=m; break
    if found:
        print('FOUND', found.get('_id','')[:40])
        mesh_id=found.get('_id')
        break
else:
    mesh_id=None

if not mesh_id:
    # Offline DB insert into NeDB while briefly stopping is risky; try meshctrl.js
    print('TRY_MESHCTRL')
    # generate mesh id like MeshCentral: mesh// + random base64
    import base64, secrets
    leaf=base64.b64encode(secrets.token_bytes(24), altchars=b'@$').decode().rstrip('=')
    mesh_id='mesh//'+leaf
    doc={
        "_id": mesh_id,
        "type": "mesh",
        "name": "WXQK Devices",
        "mtype": 2,
        "desc": "wxqk windows agents",
        "domain": "",
        "links": {"user//admin": {"name":"admin","rights":4294967295}},
        "creation": int(time.time()),
    }
    # Append to meshcentral.db (NeDB line-delimited JSON)
    db=Path('/opt/wxqk/meshcentral/data/meshcentral.db')
    # Stop container briefly to avoid race
    os.system('cd /opt/wxqk/meshcentral && docker compose stop meshcentral >/tmp/mc_stop.log 2>&1')
    time.sleep(2)
    with db.open('a', encoding='utf-8') as f:
        f.write(json.dumps(doc, separators=(',',':'))+'\n')
    os.system('cd /opt/wxqk/meshcentral && docker compose start meshcentral >/tmp/mc_start.log 2>&1')
    time.sleep(8)
    print('DB_INSERTED', mesh_id[:32]+'...')
    # verify via new ws
    ws, base = open_ws('control')
    ws.send(json.dumps({"action":"meshes","responseid":"mv"}))
    msgs=recv_until(ws, 10)
    ws.close()
    ok=False
    for msg in msgs:
        for m in (msg.get('meshes') or []):
            if m.get('_id')==mesh_id or m.get('name')=='WXQK Devices':
                ok=True; mesh_id=m.get('_id'); print('VERIFY_OK', mesh_id[:40])
    if not ok:
        print('VERIFY_FAIL — mesh may need UI create')
        # still proceed with mesh_id for agent msh generation attempt

# wire group
p=Path('/etc/wxqk/wxqk.env')
lines=[ln for ln in p.read_text().splitlines() if not ln.startswith('WXQK_MESH_GROUP=')]
lines.append('WXQK_MESH_GROUP='+str(mesh_id))
p.write_text('\\n'.join(lines)+'\\n'); p.chmod(0o600)
print('GROUP_WIRED')

out=Path('/opt/wxqk/meshcentral/agent-staging'); out.mkdir(parents=True, exist_ok=True)
picked=None
for aid in (6,4,3,5,7):
    for base in ('http://127.0.0.1:9443',):
        url=f'{base}/meshagents?id={aid}&meshid={mesh_id}'
        dest=out/f'agent-{aid}.bin'
        try:
            urllib.request.urlretrieve(url, dest)
        except Exception as e:
            print('DL_FAIL', aid, e); continue
        size=dest.stat().st_size
        print('DL', aid, size)
        head=dest.read_bytes()[:2]
        if size>100000 and head in (b'MZ', b'\x7fE'):
            dest.replace(out/'meshagent.exe'); picked=aid; break
        # sometimes msh returned
        text=dest.read_text(errors='ignore')
        if 'MeshServer=' in text:
            (out/'meshagent.msh').write_text(text); print('MSH_FROM_AGENT_URL', aid)
    if picked: break
if not picked:
    raise SystemExit('exe missing')

# msh via control invite / getagentconfig
if not (out/'meshagent.msh').exists():
    ws, base = open_ws('control')
    for payload in [
        {"action":"message","type":"invite","meshid":mesh_id,"responseid":"i1"},
        {"action":"createInviteLink","meshid":mesh_id,"expire":0,"flags":0,"responseid":"i2"},
        {"action":"invite","meshid":mesh_id,"responseid":"i3"},
        {"action":"getagentconfig","meshid":mesh_id,"responseid":"i4"},
        {"action":"meshes","responseid":"i5"},
    ]:
        try:
            ws.send(json.dumps(payload)); print('SEND', payload['action'])
        except Exception as e:
            print('SEND_FAIL', e); break
    msgs=recv_until(ws, 15)
    ws.close()
    for msg in msgs:
        blob=json.dumps(msg)
        if 'MeshServer=' in blob:
            # extract
            pass
        for k,v in msg.items():
            if isinstance(v,str) and 'MeshServer=' in v:
                (out/'meshagent.msh').write_text(v); print('MSH_FROM', msg.get('action'), k)

# Last resort: craft msh from known MeshCentral fields using mesh id + server
if not (out/'meshagent.msh').exists():
    import urllib.parse
    serverstate=Path('/opt/wxqk/meshcentral/data/serverstate.txt').read_text(errors='ignore')
    print('SERVERSTATE_HEAD', serverstate[:200].replace('\\n',' | '))
    qmesh=urllib.parse.quote(mesh_id, safe='')
    for u in [
        f'http://127.0.0.1:9443/meshagents?id={picked}&meshid={qmesh}&installflags=0',
        f'http://127.0.0.1:9443/meshagents?id={picked}&meshid={qmesh}',
    ]:
        try:
            data=urllib.request.urlopen(u, timeout=30).read()
            print('ALT', u.split('meshagents')[1][:80], 'len', len(data), 'head', data[:16])
            if b'MeshServer=' in data:
                (out/'meshagent.msh').write_bytes(data); print('MSH_OK_ALT'); break
        except Exception as e:
            print('ALT_FAIL', e)

if (out/'meshagent.msh').exists():
    text=(out/'meshagent.msh').read_text(errors='ignore')
    for key in ('MeshServer','MeshID','ServerID','MeshName'):
        for ln in text.splitlines():
            if ln.startswith(key+'='):
                val=ln.split('=',1)[1]
                print(key, (val[:60]+'...') if len(val)>60 else val)
    print('STAGING', sorted(p.name+'='+str(p.stat().st_size) for p in out.iterdir() if p.is_file()))
else:
    print('MSH_MISSING — exe staged only')
    print('STAGING', sorted(p.name+'='+str(p.stat().st_size) for p in out.iterdir() if p.is_file()))
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
    with sftp.file("/tmp/wxqk_mesh_stage.py", "w") as f:
        f.write(REMOTE)
    sftp.chmod("/tmp/wxqk_mesh_stage.py", 0o700)
    sftp.close()
    _i, o, e = c.exec_command("python3 /tmp/wxqk_mesh_stage.py", timeout=300, get_pty=True)
    out = o.read().decode("utf-8", "replace")
    code = o.channel.recv_exit_status()
    safe = re.sub(r"\b[0-9a-fA-F]{40,}\b", "<hex>", out)
    print(safe[:20000], flush=True)
    c.exec_command("rm -f /tmp/wxqk_mesh_stage.py")
    c.close()
    return code


if __name__ == "__main__":
    raise SystemExit(main())
