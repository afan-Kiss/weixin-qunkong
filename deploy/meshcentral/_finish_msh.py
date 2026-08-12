#!/usr/bin/env python3
"""Finish msh generation using MeshCentral helpers + curl auth download."""
from __future__ import annotations

import os
import re
import sys

import paramiko

sys.stdout.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)

REMOTE = """
import os, re, subprocess, json, importlib, time, ssl, socket
from pathlib import Path

for ln in Path('/etc/wxqk/wxqk.env').read_text().splitlines():
    if '=' in ln and not ln.startswith('#'):
        k,v=ln.split('=',1); os.environ[k]=v
sys.path.insert(0,'/opt/wxqk')
import meshcentral_client as mc
importlib.reload(mc)

mesh_id = os.environ.get('WXQK_MESH_GROUP','').strip()
print('MESH', mesh_id[:36]+'...' if mesh_id else 'MISSING')
out = Path('/opt/wxqk/meshcentral/agent-staging'); out.mkdir(parents=True, exist_ok=True)

# Find hash helpers in MeshCentral
subprocess.call("docker exec wxqk-meshcentral sh -c \"grep -Rn certificateToHash /opt/meshcentral/meshcentral --include='*.js' | head -n 20\"", shell=True)
subprocess.call("docker exec wxqk-meshcentral sh -c \"grep -Rn 'MeshServer=' /opt/meshcentral/meshcentral --include='*.js' | head -n 20\"", shell=True)
subprocess.call("docker exec wxqk-meshcentral sh -c \"grep -Rn '\\\\.msh' /opt/meshcentral/meshcentral --include='*.js' | head -n 30\"", shell=True)

# Probe node common exports
probe = (
    "const c=require('/opt/meshcentral/meshcentral/common.js');"
    "console.log(Object.keys(c).filter(k=>/hash|cert|mesh|agent/i.test(k)).join(','));"
)
Path('/tmp/probe.js').write_text(probe)
subprocess.check_call(['docker','cp','/tmp/probe.js','wxqk-meshcentral:/tmp/probe.js'])
print(subprocess.check_output(['docker','exec','wxqk-meshcentral','node','/tmp/probe.js'], text=True, errors='replace'))

login = mc.mint_login_token('user//admin', style='cookie', expire_min=30)
qmesh = subprocess.check_output(['python3','-c','import urllib.parse,os;print(urllib.parse.quote(os.environ[\"M\"], safe=\"\"))'], env={**os.environ,'M':mesh_id}, text=True).strip()

# curl download with login for possible msh; also keep exe
cmd = (
    f"curl -sk --resolve 120.27.219.138:8444:127.0.0.1 "
    f"\"https://120.27.219.138:8444/meshagents?id=3&meshid={qmesh}&login={login}\" "
    f"-o /opt/wxqk/meshcentral/agent-staging/auth-agent.bin "
    f"-w 'http=%{{http_code}} size=%{{size_download}}\\n'"
)
print(subprocess.check_output(cmd, shell=True, text=True, errors='replace'))
p = out/'auth-agent.bin'
if p.exists():
    head=p.read_bytes()[:2]
    print('auth head', head, 'size', p.stat().st_size)
    if head==b'MZ':
        p.replace(out/'meshagent.exe')
    elif b'MeshServer=' in p.read_bytes():
        p.replace(out/'meshagent.msh')

# Ensure exe exists
if not (out/'meshagent.exe').exists() or (out/'meshagent.exe').read_bytes()[:2]!=b'MZ':
    subprocess.check_call(['curl','-s','http://127.0.0.1:9443/meshagents?id=3','-o',str(out/'meshagent.exe')])
print('EXE', (out/'meshagent.exe').stat().st_size)

# Generate msh with robust hash extraction from MeshCentral
gen = r'''
const fs = require('fs');
const forgePathCandidates = [
  '/opt/meshcentral/meshcentral/node_modules/node-forge',
  '/opt/meshcentral/node_modules/node-forge'
];
let forge=null;
for (const p of forgePathCandidates) { try { forge=require(p); break; } catch(e) {} }
const common = require('/opt/meshcentral/meshcentral/common.js');
const certPem = fs.readFileSync('/opt/meshcentral/meshcentral-data/agentserver-cert-public.crt', 'utf8');
let serverid = '';
const tries = [];
if (typeof common.certificateToHash === 'function') {
  try { serverid = common.certificateToHash(certPem); tries.push('certPem'); } catch(e) { tries.push('certPemERR='+e.message); }
  try { if(!serverid) serverid = common.certificateToHash(Buffer.from(certPem)); tries.push('certBuf'); } catch(e) { tries.push('certBufERR='+e.message); }
}
if (!serverid && forge) {
  try {
    const cert = forge.pki.certificateFromPem(certPem);
    const asn1 = forge.pki.certificateToAsn1(cert);
    const der = forge.asn1.toDer(asn1).getBytes();
    const md = forge.md.sha384.create();
    md.update(der);
    serverid = md.digest().toHex();
    tries.push('forge-sha384-cert');
  } catch(e) { tries.push('forgeERR='+e.message); }
}
// MeshCentral often hashes the public key, not full cert
if (!serverid && forge) {
  try {
    const cert = forge.pki.certificateFromPem(certPem);
    const asn1 = forge.pki.publicKeyToAsn1(cert.publicKey);
    const der = forge.asn1.toDer(asn1).getBytes();
    const md = forge.md.sha384.create();
    md.update(der);
    serverid = md.digest().toHex();
    tries.push('forge-sha384-spki');
  } catch(e) { tries.push('spkiERR='+e.message); }
}
const meshid = process.env.MID;
const MeshServer = process.env.MS;
const lines = [
  'MeshName=WXQK Devices',
  'MeshID=' + meshid,
  'ServerID=' + serverid,
  'MeshServer=' + MeshServer
];
fs.writeFileSync('/tmp/out.msh', lines.join('\\r\\n') + '\\r\\n');
console.log(JSON.stringify({sidlen: serverid.length, tries, mid: meshid.slice(0,24)}));
'''
# Write gen without breaking Python — use Path write from bytes escaping
Path('/tmp/gen_msh2.js').write_text(gen.replace('\\\\r\\\\n', '\\r\\n') if False else gen)
# Fix: in the string above we used \\\\r\\\\n in join - actually in the triple we need real \\r\\n in JS source
# Rewrite cleanly:
gen2 = (
"const fs=require('fs');\\n"
"let forge=null; try{forge=require('/opt/meshcentral/meshcentral/node_modules/node-forge')}catch(e){try{forge=require('node-forge')}catch(e2){}}\\n"
"const common=require('/opt/meshcentral/meshcentral/common.js');\\n"
"const certPem=fs.readFileSync('/opt/meshcentral/meshcentral-data/agentserver-cert-public.crt','utf8');\\n"
"let serverid=''; const tries=[];\\n"
"if(typeof common.certificateToHash==='function'){\\n"
"  try{serverid=common.certificateToHash(certPem);tries.push('pem')}catch(e){tries.push('pemERR')}\\n"
"  try{if(!serverid){serverid=common.certificateToHash(Buffer.from(certPem));tries.push('buf')}}catch(e){tries.push('bufERR')}\\n"
"}\\n"
"if(!serverid && forge){\\n"
"  try{const cert=forge.pki.certificateFromPem(certPem); const md=forge.md.sha384.create(); md.update(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes()); serverid=md.digest().toHex(); tries.push('sha384cert')}catch(e){tries.push('sha384certERR='+e.message)}\\n"
"}\\n"
"if(!serverid && forge){\\n"
"  try{const cert=forge.pki.certificateFromPem(certPem); const md=forge.md.sha384.create(); md.update(forge.asn1.toDer(forge.pki.publicKeyToAsn1(cert.publicKey)).getBytes()); serverid=md.digest().toHex(); tries.push('sha384spki')}catch(e){tries.push('spkiERR='+e.message)}\\n"
"}\\n"
"const lines=['MeshName=WXQK Devices','MeshID='+process.env.MID,'ServerID='+serverid,'MeshServer='+process.env.MS];\\n"
"fs.writeFileSync('/tmp/out.msh', lines.join(String.fromCharCode(13,10))+String.fromCharCode(13,10));\\n"
"console.log(JSON.stringify({sidlen:serverid.length,tries:tries}));\\n"
)
Path('/tmp/gen_msh2.js').write_text(bytes(gen2, 'utf-8').decode('unicode_escape'))
subprocess.check_call(['docker','cp','/tmp/gen_msh2.js','wxqk-meshcentral:/tmp/gen_msh2.js'])

leaf = mesh_id.split('//')[-1]
cands = [mesh_id, leaf]
try:
    import base64
    raw = base64.b64decode(leaf + '==', altchars=b'@$')
    cands.append('0x' + raw.hex())
except Exception as e:
    print('b64', e)

ok=False
for mid in cands:
    for ms in ('wss://120.27.219.138:4433/agent.ashx','wss://120.27.219.138:8444/agent.ashx'):
        try:
            outp=subprocess.check_output(
                ['docker','exec','-e','MID='+mid,'-e','MS='+ms,'wxqk-meshcentral','node','/tmp/gen_msh2.js'],
                stderr=subprocess.STDOUT, text=True, errors='replace'
            )
        except subprocess.CalledProcessError as e:
            print('GEN_FAIL', e.output); continue
        print('GEN', outp.strip())
        subprocess.check_call(['docker','cp','wxqk-meshcentral:/tmp/out.msh', str(out/'meshagent.msh')])
        text=(out/'meshagent.msh').read_text(errors='ignore')
        sid=''
        for ln in text.splitlines():
            if ln.startswith('ServerID='): sid=ln.split('=',1)[1].strip()
        if sid:
            ok=True
            for key in ('MeshName','MeshServer','MeshID','ServerID'):
                for ln in text.splitlines():
                    if ln.startswith(key+'='):
                        val=ln.split('=',1)[1]
                        print(key, (val[:72]+'...') if len(val)>72 else val)
            break
    if ok: break

print('STAGING', sorted(f'{p.name}={p.stat().st_size}' for p in out.iterdir() if p.is_file()))
if not ok or not (out/'meshagent.exe').exists():
    raise SystemExit('incomplete')
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
    with sftp.file("/tmp/wxqk_finish_msh.py", "w") as f:
        f.write(REMOTE)
    sftp.chmod("/tmp/wxqk_finish_msh.py", 0o700)
    sftp.close()
    _i, o, e = c.exec_command("python3 /tmp/wxqk_finish_msh.py", timeout=300, get_pty=True)
    out = o.read().decode("utf-8", "replace")
    code = o.channel.recv_exit_status()
    print(re.sub(r"\b[0-9a-fA-F]{40,}\b", "<hex>", out)[:25000], flush=True)
    c.close()
    return code


if __name__ == "__main__":
    raise SystemExit(main())
