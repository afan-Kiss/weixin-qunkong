#!/usr/bin/env python3
"""Diagnose MeshCentral auth close cause; sync real loginTokenKey; fetch Windows agent."""
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

# 1) Find real loginTokenEncryptionKey used by MeshCentral
root=Path('/opt/wxqk/meshcentral/data')
found_keys=[]
for p in root.rglob('*'):
    if not p.is_file() or p.stat().st_size>5_000_000: continue
    try:
        t=p.read_text(errors='ignore')
    except Exception:
        continue
    if 'loginToken' in t or 'TokenKey' in t or 'tokenKey' in t:
        print('HIT_FILE', p.name)
        for pat in [
            r'loginTokenEncryptionKey["\']?\s*[:=]\s*["\']([0-9a-fA-F]{32,})',
            r'loginTokenKey["\']?\s*[:=]\s*["\']([0-9a-fA-F]{32,})',
        ]:
            import re
            m=re.search(pat, t)
            if m:
                found_keys.append(m.group(1).lower())
                print('KEY_FROM', p.name, 'len', len(m.group(1)))
        try:
            j=json.loads(t)
            s=j.get('settings') or {}
            for k in ('loginTokenEncryptionKey','loginTokenKey'):
                if isinstance(s.get(k), str) and len(s[k])>=32:
                    found_keys.append(s[k].lower()); print('JSON_KEY', k, 'len', len(s[k]))
        except Exception:
            pass

# Also dump --loginTokenEncryptionKey / print from running node via docker
import subprocess
for args in [
    ['docker','exec','wxqk-meshcentral','node','/opt/meshcentral/meshcentral/meshcentral.js','--loginTokenEncryptionKey'],
    ['docker','exec','wxqk-meshcentral','node','/opt/meshcentral/meshcentral/meshcentral.js','--loginTokenKey'],
]:
    try:
        out=subprocess.check_output(args, stderr=subprocess.STDOUT, timeout=60, text=True, errors='replace')
        print('CLI', args[-1], 'OUT_LEN', len(out.strip()), 'LINES', len(out.splitlines()))
        for line in out.splitlines():
            line=line.strip().strip('"').strip("'")
            if len(line)>=32 and all(c in '0123456789abcdefABCDEF' for c in line):
                found_keys.append(line.lower()); print('CLI_KEY_LEN', len(line))
    except Exception as e:
        print('CLI_FAIL', args[-1], e)

# Dedup
keys=[]
for k in found_keys:
    if k not in keys: keys.append(k)
print('CANDIDATE_COUNT', len(keys))

# Show env key length
env_key=(os.environ.get('WXQK_MESH_LOGIN_KEY') or '').strip().lower()
print('ENV_KEY_LEN', len(env_key), 'MATCH_ANY', env_key in keys if env_key else False)

import meshcentral_client as mc
import websocket

def try_auth(key_hex, style):
    os.environ['WXQK_MESH_LOGIN_KEY']=key_hex
    # clear cached key if any
    if hasattr(mc, '_login_key_bytes'):
        pass
    # reload key function by reimport? just set env before call
    token = mc.mint_login_token('user//admin', style=style, expire_min=30)
    url='ws://127.0.0.1:9443/control.ashx?auth='+token
    ws=websocket.create_connection(url, timeout=15)
    ws.send(json.dumps({"action":"serverinfo","responseid":"t1"}))
    ws.send(json.dumps({"action":"meshes","responseid":"t2"}))
    end=time.time()+8
    msgs=[]
    while time.time()<end:
        ws.settimeout(max(0.2, end-time.time()))
        try:
            raw=ws.recv()
        except Exception:
            break
        try:
            msg=json.loads(raw)
        except Exception:
            continue
        msgs.append(msg)
        if msg.get('action')=='close':
            print('CLOSE', 'style', style, 'cause', msg.get('cause'), 'msg', msg.get('msg'))
            break
        print('OKMSG', style, msg.get('action'), msg.get('responseid'))
    try: ws.close()
    except Exception: pass
    return msgs

# Test env key and candidates
test_keys = []
if env_key: test_keys.append(('env', env_key))
for i,k in enumerate(keys):
    test_keys.append((f'cand{i}', k))

winner=None
for label,k in test_keys[:6]:
    print('TRY', label, 'len', len(k))
    # mint uses _login_key_bytes which reads env each time hopefully
    import importlib
    importlib.reload(mc)
    os.environ['WXQK_MESH_LOGIN_KEY']=k
    msgs=try_auth(k, 'control')
    if any(m.get('action') in ('serverinfo','meshes','userinfo') for m in msgs):
        winner=k; print('WINNER', label); break
    msgs=try_auth(k, 'cookie')
    if any(m.get('action') in ('serverinfo','meshes','userinfo') for m in msgs):
        winner=k; print('WINNER_COOKIE', label); break

if not winner:
    # Inspect how MeshCentral stores key in config.json inside data (mounted)
    cfg=json.loads(Path('/opt/wxqk/meshcentral/config.json').read_text())
    print('CONFIG_SETTINGS_KEYS', sorted((cfg.get('settings') or {}).keys()))
    # Search meshcentral.js for default key generation offline — read serverstate / db docs
    # Try extracting from meshcentral.db user session? 
    db=Path('/opt/wxqk/meshcentral/data/meshcentral.db').read_text(errors='ignore')
    import re
    for m in re.finditer(r'loginTokenEncryptionKey.{0,20}([0-9a-fA-F]{64,})', db):
        print('DB_KEY_LEN', len(m.group(1))); winner=m.group(1).lower(); break
    if not winner:
        for m in re.finditer(r'([0-9a-fA-F]{160})', db):
            # too noisy
            pass

if winner:
    # Wire winner into env files
    for path in [Path('/opt/wxqk/meshcentral/.env'), Path('/etc/wxqk/wxqk.env')]:
        lines=[]
        seen=False
        for ln in path.read_text().splitlines():
            if ln.startswith('WXQK_MESH_LOGIN_KEY='):
                lines.append('WXQK_MESH_LOGIN_KEY='+winner); seen=True
            else:
                lines.append(ln)
        if not seen:
            lines.append('WXQK_MESH_LOGIN_KEY='+winner)
        path.write_text('\\n'.join(lines)+'\\n'); path.chmod(0o600)
    print('KEY_WIRED_LEN', len(winner))
    os.system('systemctl restart wxqk')
    time.sleep(2)
else:
    print('NO_WINNER')

# 2) Regardless — download Windows PE agents (MZ) for common ids
out=Path('/opt/wxqk/meshcentral/agent-staging'); out.mkdir(parents=True, exist_ok=True)
for aid in (3,4,5,7,14,16,1,2):
    url=f'http://127.0.0.1:9443/meshagents?id={aid}'
    dest=out/f'probe-{aid}.bin'
    try:
        urllib.request.urlretrieve(url, dest)
    except Exception as e:
        print('PROBE_FAIL', aid, e); continue
    head=dest.read_bytes()[:4]
    size=dest.stat().st_size
    kind='MZ' if head[:2]==b'MZ' else ('ELF' if head[:4]==b'\\x7fELF' else head.hex())
    print('PROBE', aid, size, kind)
    if head[:2]==b'MZ' and size>500000:
        dest.replace(out/'meshagent.exe')
        print('WINDOWS_AGENT_ID', aid)
        break

print('STAGING', sorted(f'{p.name}={p.stat().st_size}' for p in out.iterdir() if p.is_file()))
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
    with sftp.file("/tmp/wxqk_fix_auth.py", "w") as f:
        f.write(REMOTE)
    sftp.chmod("/tmp/wxqk_fix_auth.py", 0o700)
    sftp.close()
    _i, o, e = c.exec_command("python3 /tmp/wxqk_fix_auth.py", timeout=300, get_pty=True)
    out = o.read().decode("utf-8", "replace")
    code = o.channel.recv_exit_status()
    safe = re.sub(r"(?i)(WXQK_MESH_LOGIN_KEY=)[0-9a-fA-F]+", r"\1<redacted>", out)
    safe = re.sub(r"\b[0-9a-fA-F]{48,}\b", "<hex>", safe)
    print(safe[:20000], flush=True)
    c.exec_command("rm -f /tmp/wxqk_fix_auth.py")
    c.close()
    return code


if __name__ == "__main__":
    raise SystemExit(main())
