#!/usr/bin/env python3
"""Create mesh + msh with correct WS Origin; fetch Windows agent id=3."""
from __future__ import annotations

import os
import re
import sys

import paramiko

sys.stdout.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)

# Keep remote script free of triple-quotes.
REMOTE = """
import json, os, re, sys, time, urllib.request, urllib.parse, subprocess, importlib
from pathlib import Path

cli = subprocess.check_output(
    ['docker', 'exec', 'wxqk-meshcentral', 'node', '/opt/meshcentral/meshcentral/meshcentral.js', '--loginTokenKey'],
    stderr=subprocess.STDOUT, timeout=60, text=True, errors='replace'
)
key = ''
for line in cli.splitlines():
    line = line.strip().strip('"').strip("'")
    if len(line) >= 64 and all(c in '0123456789abcdefABCDEF' for c in line):
        key = line.lower()
        break
if not key:
    raise SystemExit('no loginTokenKey from CLI')

def upsert_env(path, updates):
    path = Path(path)
    lines = path.read_text().splitlines() if path.exists() else []
    keys = set(updates)
    out = []
    seen = set()
    for ln in lines:
        if not ln.strip() or ln.strip().startswith('#'):
            out.append(ln)
            continue
        k = ln.split('=', 1)[0]
        if k in keys:
            out.append(k + '=' + updates[k])
            seen.add(k)
        else:
            out.append(ln)
    for k, v in updates.items():
        if k not in seen:
            out.append(k + '=' + v)
    path.write_text('\\n'.join(out) + '\\n')
    path.chmod(0o600)

base_updates = {
    'WXQK_MESH_ENABLED': '1',
    'WXQK_MESH_URL': 'https://120.27.219.138:8444',
    'WXQK_MESH_INTERNAL_URL': 'http://127.0.0.1:9443',
    'WXQK_MESH_USER': 'user//admin',
    'WXQK_MESH_LOGIN_KEY': key,
    'WXQK_MESH_TOKEN_EXPIRE_MIN': '30',
    'WXQK_MESH_TIMEOUT': '15',
}
upsert_env('/opt/wxqk/meshcentral/.env', base_updates)
upsert_env('/etc/wxqk/wxqk.env', base_updates)
print('KEY_WIRED_LEN', len(key))

for ln in Path('/etc/wxqk/wxqk.env').read_text().splitlines():
    if '=' in ln and not ln.startswith('#'):
        k, v = ln.split('=', 1)
        os.environ[k] = v

sys.path.insert(0, '/opt/wxqk')
import meshcentral_client as mc
importlib.reload(mc)
import websocket

ORIGIN = 'https://120.27.219.138:8444'

def open_ws(style='control'):
    token = mc.mint_login_token('user//admin', style=style, expire_min=30)
    url = 'ws://127.0.0.1:9443/control.ashx?auth=' + token
    return websocket.create_connection(
        url,
        timeout=20,
        origin=ORIGIN,
        header=['Origin: ' + ORIGIN, 'Host: 120.27.219.138:8444'],
    )

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
        print('RECV', msg.get('action'), msg.get('responseid') or msg.get('cause') or '')
        if msg.get('action') == 'close':
            print('CLOSE_DETAIL', msg)
            break
    return msgs

found = None
meshes = []
for style in ('control', 'cookie'):
    ws = open_ws(style)
    ws.send(json.dumps({'action': 'serverinfo', 'responseid': 's1'}))
    ws.send(json.dumps({'action': 'meshes', 'responseid': 'm1'}))
    msgs = drain(ws, 8)
    if any(m.get('action') == 'close' for m in msgs):
        try:
            ws.close()
        except Exception:
            pass
        continue
    for m in msgs:
        if m.get('action') == 'meshes':
            meshes = m.get('meshes') or []
    print('STYLE_OK', style, 'meshes', len(meshes))
    for x in meshes:
        if x.get('name') == 'WXQK Devices':
            found = x
    if not found:
        ws.send(json.dumps({
            'action': 'createmesh',
            'meshname': 'WXQK Devices',
            'meshtype': 2,
            'desc': 'wxqk',
            'responseid': 'c1',
        }))
        for m in drain(ws, 10):
            if m.get('action') == 'createmesh' and isinstance(m.get('mesh'), dict):
                found = m['mesh']
            if m.get('action') == 'meshes':
                for x in (m.get('meshes') or []):
                    if x.get('name') == 'WXQK Devices':
                        found = x
        if not found:
            ws.send(json.dumps({'action': 'meshes', 'responseid': 'm3'}))
            for m in drain(ws, 8):
                if m.get('action') == 'meshes':
                    for x in (m.get('meshes') or []):
                        if x.get('name') == 'WXQK Devices':
                            found = x
    try:
        ws.close()
    except Exception:
        pass
    if found:
        break

if not found:
    raise SystemExit('createmesh failed')

mesh_id = found.get('_id')
print('MESH_OK', str(mesh_id)[:28] + '...')
upsert_env('/etc/wxqk/wxqk.env', {'WXQK_MESH_GROUP': mesh_id})

out = Path('/opt/wxqk/meshcentral/agent-staging')
out.mkdir(parents=True, exist_ok=True)
aid = 3
q = urllib.parse.quote(mesh_id, safe='')
urllib.request.urlretrieve(
    'http://127.0.0.1:9443/meshagents?id=%d&meshid=%s' % (aid, q),
    out / 'meshagent.exe',
)
head = (out / 'meshagent.exe').read_bytes()[:2]
print('EXE', (out / 'meshagent.exe').stat().st_size, 'MZ' if head == b'MZ' else head)

# Generate msh inside container using MeshCentral common.certificateToHash
gen_js = (
    "const fs=require('fs');"
    "const common=require('/opt/meshcentral/meshcentral/common.js');"
    "const meshid=process.env.MID;"
    "const meshname='WXQK Devices';"
    "const MeshServer=process.env.MS;"
    "const agentCert=fs.readFileSync('/opt/meshcentral/meshcentral-data/agentserver-cert-public.crt');"
    "let serverid='';"
    "try{serverid=common.certificateToHash(agentCert);}catch(e){console.log('HASHERR='+e);}"
    "const lines=['MeshName='+meshname,'MeshID='+meshid,'ServerID='+serverid,'MeshServer='+MeshServer];"
    "fs.writeFileSync('/tmp/out.msh', lines.join('\\r\\n')+'\\r\\n');"
    "console.log('WROTE sidlen='+(serverid?serverid.length:0));"
)
Path('/tmp/gen_msh.js').write_text(gen_js)
subprocess.check_call(['docker', 'cp', '/tmp/gen_msh.js', 'wxqk-meshcentral:/tmp/gen_msh.js'])

# MeshID format in .msh is usually hex of binary mesh id — try several forms
candidates = [mesh_id]
leaf = mesh_id.split('//')[-1] if '//' in mesh_id else mesh_id
candidates.append(leaf)
# hex form used by many MeshCentral versions: 0x + hex
try:
    import base64
    raw = base64.b64decode(leaf + '==', altchars=b'@$')
    candidates.append('0x' + raw.hex())
except Exception as e:
    print('B64_FAIL', e)

msh_ok = False
for mid in candidates:
    for ms in (
        'wss://120.27.219.138:4433/agent.ashx',
        'wss://120.27.219.138:8444/agent.ashx',
        'wss://120.27.219.138/agent.ashx',
    ):
        outp = subprocess.check_output(
            ['docker', 'exec', '-e', 'MID=' + mid, '-e', 'MS=' + ms, 'wxqk-meshcentral', 'node', '/tmp/gen_msh.js'],
            stderr=subprocess.STDOUT, text=True, errors='replace', timeout=30,
        )
        print('GEN', outp.strip(), 'mid', mid[:24], 'ms', ms)
        subprocess.check_call(['docker', 'cp', 'wxqk-meshcentral:/tmp/out.msh', str(out / 'meshagent.msh')])
        text = (out / 'meshagent.msh').read_text(errors='ignore')
        sid = ''
        for ln in text.splitlines():
            if ln.startswith('ServerID='):
                sid = ln.split('=', 1)[1].strip()
        if sid:
            print('MSH_CANDIDATE_OK sidlen', len(sid), 'MeshServer', ms)
            msh_ok = True
            break
    if msh_ok:
        break

if not msh_ok:
    raise SystemExit('msh generation failed')

text = (out / 'meshagent.msh').read_text(errors='ignore')
for keyname in ('MeshName', 'MeshServer', 'MeshID', 'ServerID'):
    for ln in text.splitlines():
        if ln.startswith(keyname + '='):
            val = ln.split('=', 1)[1]
            print(keyname, (val[:70] + '...') if len(val) > 70 else val)

# Also try control getagentconfig now that auth works
ws = open_ws('control')
ws.send(json.dumps({'action': 'getagentconfig', 'meshid': mesh_id, 'responseid': 'g1'}))
for m in drain(ws, 8):
    for k, v in m.items():
        if isinstance(v, str) and 'MeshServer=' in v:
            (out / 'meshagent.msh').write_text(v)
            print('MSH_REPLACED_FROM_CONTROL')
try:
    ws.close()
except Exception:
    pass

os.system('systemctl restart wxqk')
time.sleep(2)
print('STAGING', sorted(f'{p.name}={p.stat().st_size}' for p in out.iterdir() if p.is_file()))
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
    with sftp.file("/tmp/wxqk_origin_mesh.py", "w") as f:
        f.write(REMOTE)
    sftp.chmod("/tmp/wxqk_origin_mesh.py", 0o700)
    sftp.close()
    _i, o, e = c.exec_command("python3 /tmp/wxqk_origin_mesh.py", timeout=300, get_pty=True)
    out = o.read().decode("utf-8", "replace")
    code = o.channel.recv_exit_status()
    safe = re.sub(r"\b[0-9a-fA-F]{40,}\b", "<hex>", out)
    print(safe[:20000], flush=True)
    c.exec_command("rm -f /tmp/wxqk_origin_mesh.py /tmp/gen_msh.js")
    c.close()
    return code


if __name__ == "__main__":
    raise SystemExit(main())
