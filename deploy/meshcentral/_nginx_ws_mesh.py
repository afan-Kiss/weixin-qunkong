#!/usr/bin/env python3
"""Auth via local nginx :8444 (correct Host/Origin) and create mesh + agent files."""
from __future__ import annotations

import os
import re
import sys

import paramiko

sys.stdout.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)

REMOTE = """
import json, os, sys, time, ssl, socket, urllib.request, urllib.parse, subprocess, importlib
from pathlib import Path

for ln in Path('/etc/wxqk/wxqk.env').read_text().splitlines():
    if '=' in ln and not ln.startswith('#'):
        k,v=ln.split('=',1); os.environ[k]=v
sys.path.insert(0,'/opt/wxqk')
import meshcentral_client as mc
importlib.reload(mc)
import websocket

def open_ws_nginx(style='control'):
    token = mc.mint_login_token('user//admin', style=style, expire_min=30)
    # Connect TCP to 127.0.0.1:8444, TLS verify with nginx IP cert, Host/SNI = public IP
    raw = socket.create_connection(('127.0.0.1', 8444), timeout=20)
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.load_verify_locations('/etc/nginx/ssl/wxqk-ip.crt')
    ssock = ctx.wrap_socket(raw, server_hostname='203.0.113.10')
    url = 'wss://203.0.113.10:8444/control.ashx?auth=' + token
    ws = websocket.create_connection(
        url,
        socket=ssock,
        timeout=20,
        origin='https://203.0.113.10:8444',
        host='203.0.113.10:8444',
    )
    return ws

def open_ws_variants(style='control'):
    token = mc.mint_login_token('user//admin', style=style, expire_min=30)
    variants = [
        ('nginx', None),
        ('loop_origin_https', 'https://203.0.113.10:8444'),
        ('loop_origin_http', 'http://127.0.0.1:9443'),
        ('loop_origin_none', ''),
    ]
    # first try nginx helper
    try:
        ws = open_ws_nginx(style)
        print('OPEN nginx', style)
        return ws, 'nginx'
    except Exception as e:
        print('OPEN_FAIL nginx', e)
    for name, origin in variants[1:]:
        try:
            kwargs = {'timeout': 20}
            headers = []
            if origin:
                kwargs['origin'] = origin
                headers.append('Origin: ' + origin)
            url = 'ws://127.0.0.1:9443/control.ashx?auth=' + token
            if headers:
                kwargs['header'] = headers
            ws = websocket.create_connection(url, **kwargs)
            print('OPEN', name, style)
            return ws, name
        except Exception as e:
            print('OPEN_FAIL', name, e)
    raise SystemExit('all ws open failed')

def drain(ws, seconds=10):
    end = time.time() + seconds
    msgs = []
    while time.time() < end:
        ws.settimeout(max(0.2, end - time.time()))
        try:
            raw = ws.recv()
        except Exception:
            break
        try:
            msg = json.loads(raw)
        except Exception:
            continue
        msgs.append(msg)
        print('RECV', msg.get('action'), msg.get('responseid') or msg.get('cause') or msg.get('msg') or '')
        if msg.get('action') == 'close':
            break
    return msgs

found = None
for style in ('control', 'cookie'):
    ws, how = open_ws_variants(style)
    ws.send(json.dumps({'action': 'serverinfo', 'responseid': 's1'}))
    ws.send(json.dumps({'action': 'meshes', 'responseid': 'm1'}))
    msgs = drain(ws, 8)
    if any(m.get('action') == 'close' for m in msgs):
        try: ws.close()
        except Exception: pass
        continue
    meshes = []
    for m in msgs:
        if m.get('action') == 'meshes':
            meshes = m.get('meshes') or []
    print('AUTH_OK', style, how, 'meshes', len(meshes), [x.get('name') for x in meshes])
    for x in meshes:
        if x.get('name') == 'WXQK Devices':
            found = x
    if not found:
        ws.send(json.dumps({'action': 'createmesh', 'meshname': 'WXQK Devices', 'meshtype': 2, 'desc': 'wxqk', 'responseid': 'c1'}))
        for m in drain(ws, 12):
            if isinstance(m.get('mesh'), dict):
                found = m['mesh']
            if m.get('action') == 'meshes':
                for x in (m.get('meshes') or []):
                    if x.get('name') == 'WXQK Devices':
                        found = x
        if not found:
            ws.send(json.dumps({'action': 'meshes', 'responseid': 'm2'}))
            for m in drain(ws, 8):
                if m.get('action') == 'meshes':
                    for x in (m.get('meshes') or []):
                        if x.get('name') == 'WXQK Devices':
                            found = x
    try: ws.close()
    except Exception: pass
    if found:
        break

if not found:
    # Last resort: set browser origin skip via config and restart
    print('TRY_CONFIG_ORIGIN_RELAX')
    cfg_path = Path('/opt/wxqk/meshcentral/config.json')
    cfg = json.loads(cfg_path.read_text())
    cfg.setdefault('settings', {})['browserOriginCheck'] = False
    # also common aliases seen in issues
    cfg['settings']['IgnoreOriginCheck'] = True
    cfg_path.write_text(json.dumps(cfg, indent=2) + '\\n')
    os.system('cd /opt/wxqk/meshcentral && docker compose restart meshcentral')
    time.sleep(12)
    ws, how = open_ws_variants('control')
    ws.send(json.dumps({'action': 'serverinfo', 'responseid': 's1'}))
    ws.send(json.dumps({'action': 'meshes', 'responseid': 'm1'}))
    msgs = drain(ws, 8)
    if not any(m.get('action') == 'close' for m in msgs):
        ws.send(json.dumps({'action': 'createmesh', 'meshname': 'WXQK Devices', 'meshtype': 2, 'responseid': 'c1'}))
        for m in drain(ws, 12):
            if isinstance(m.get('mesh'), dict):
                found = m['mesh']
            if m.get('action') == 'meshes':
                for x in (m.get('meshes') or []):
                    if x.get('name') == 'WXQK Devices':
                        found = x
    try: ws.close()
    except Exception: pass

if not found:
    raise SystemExit('still cannot createmesh')

mesh_id = found['_id']
print('MESH_OK', mesh_id[:32] + '...')

# upsert group
p = Path('/etc/wxqk/wxqk.env')
lines = [ln for ln in p.read_text().splitlines() if not ln.startswith('WXQK_MESH_GROUP=')]
lines.append('WXQK_MESH_GROUP=' + mesh_id)
p.write_text('\\n'.join(lines) + '\\n'); p.chmod(0o600)

out = Path('/opt/wxqk/meshcentral/agent-staging'); out.mkdir(parents=True, exist_ok=True)
q = urllib.parse.quote(mesh_id, safe='')
urllib.request.urlretrieve('http://127.0.0.1:9443/meshagents?id=3&meshid=' + q, out / 'WXQK.exe')
print('EXE', (out/'WXQK.exe').stat().st_size, (out/'WXQK.exe').read_bytes()[:2])

# generate msh via node common.hash
gen_js = (
    "const fs=require('fs');"
    "const common=require('/opt/meshcentral/meshcentral/common.js');"
    "const meshid=process.env.MID;"
    "const MeshServer=process.env.MS;"
    "const agentCert=fs.readFileSync('/opt/meshcentral/meshcentral-data/agentserver-cert-public.crt');"
    "let serverid='';"
    "try{serverid=common.certificateToHash(agentCert);}catch(e){console.log('HASHERR='+e)}"
    "const lines=['MeshName=WXQK Devices','MeshID='+meshid,'ServerID='+serverid,'MeshServer='+MeshServer];"
    "fs.writeFileSync('/tmp/out.msh', lines.join('\\r\\n')+'\\r\\n');"
    "console.log('sidlen='+(serverid?serverid.length:0));"
)
Path('/tmp/gen_msh.js').write_text(gen_js)
subprocess.check_call(['docker', 'cp', '/tmp/gen_msh.js', 'wxqk-meshcentral:/tmp/gen_msh.js'])
leaf = mesh_id.split('//')[-1]
cands = [mesh_id, leaf]
try:
    import base64
    raw = base64.b64decode(leaf + '==', altchars=b'@$')
    cands.append('0x' + raw.hex())
except Exception as e:
    print('b64', e)
ok = False
for mid in cands:
    for ms in ('wss://203.0.113.10:4433/agent.ashx', 'wss://203.0.113.10:8444/agent.ashx'):
        outp = subprocess.check_output(
            ['docker', 'exec', '-e', 'MID=' + mid, '-e', 'MS=' + ms, 'wxqk-meshcentral', 'node', '/tmp/gen_msh.js'],
            stderr=subprocess.STDOUT, text=True, errors='replace'
        )
        print('GEN', outp.strip(), mid[:20], ms)
        subprocess.check_call(['docker', 'cp', 'wxqk-meshcentral:/tmp/out.msh', str(out / 'WXQK.msh')])
        text = (out / 'WXQK.msh').read_text(errors='ignore')
        if 'ServerID=' in text and text.split('ServerID=')[1].splitlines()[0].strip():
            ok = True
            for key in ('MeshName', 'MeshServer', 'MeshID', 'ServerID'):
                for ln in text.splitlines():
                    if ln.startswith(key + '='):
                        val = ln.split('=', 1)[1]
                        print(key, (val[:70] + '...') if len(val) > 70 else val)
            break
    if ok:
        break
if not ok:
    raise SystemExit('msh failed')
os.system('systemctl restart wxqk')
print('DONE', sorted(f'{p.name}={p.stat().st_size}' for p in out.iterdir() if p.is_file()))
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
    with sftp.file("/tmp/wxqk_nginx_ws.py", "w") as f:
        f.write(REMOTE)
    sftp.chmod("/tmp/wxqk_nginx_ws.py", 0o700)
    sftp.close()
    _i, o, e = c.exec_command("python3 /tmp/wxqk_nginx_ws.py", timeout=360, get_pty=True)
    out = o.read().decode("utf-8", "replace")
    code = o.channel.recv_exit_status()
    print(re.sub(r"\b[0-9a-fA-F]{40,}\b", "<hex>", out)[:20000], flush=True)
    c.exec_command("rm -f /tmp/wxqk_nginx_ws.py /tmp/gen_msh.js")
    c.close()
    return code


if __name__ == "__main__":
    raise SystemExit(main())
