#!/usr/bin/env python3
"""
Official WXQK agent artifact provisioning for MeshCentral 1.2.4.

NOT a hand-made .msh generator inventing ServerID/MeshID:
- EXE comes from MeshCentral /meshagents?id=4 (branded Content-Disposition via agentCustomization)
- ServerID is MeshCentral agentCertificateHashHex (forge public-key SHA384)
- MeshID is the configured device group (WXQK_MESH_GROUP)
- MeshServer uses AgentPort when AgentPortTls is enabled (production WXQK layout)

Usage (on Mesh/wxqk host):
  python3 deploy/meshcentral/provision_official_agent.py

Writes:
  admin-ui/resources/meshcentral/WXQK.exe
  admin-ui/resources/meshcentral/WXQK.msh
  and/or /opt/wxqk/meshcentral/agent-staging/
"""
from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
OUT_CANDIDATES = [
    REPO / "admin-ui" / "resources" / "meshcentral",
    Path("/opt/wxqk/meshcentral/agent-staging"),
    HERE / "agent-staging",
]


def load_env() -> dict[str, str]:
    env: dict[str, str] = {}
    for p in (
        Path("/etc/wxqk/mesh.env"),
        Path("/etc/wxqk/wxqk.env"),
        HERE / ".env",
        HERE / "wxqk-mesh.env",
    ):
        if not p.exists():
            continue
        for ln in p.read_text(encoding="utf-8", errors="replace").splitlines():
            ln = ln.strip()
            if not ln or ln.startswith("#") or "=" not in ln:
                continue
            k, v = ln.split("=", 1)
            k, v = k.strip(), v.strip().strip('"').strip("'")
            if v and k not in env:
                env[k] = v
    return env


def download_exe(out: Path) -> None:
    url = "http://127.0.0.1:9080/meshagents?id=4"
    with urllib.request.urlopen(url, timeout=120) as resp:
        data = resp.read()
    if data[:2] != b"MZ" or len(data) < 1_000_000:
        raise SystemExit(f"invalid agent exe from {url}: size={len(data)} head={data[:16]!r}")
    out.write_bytes(data)
    print(f"EXE_OK size={len(data)} sha256={hashlib.sha256(data).hexdigest()[:16]}")


def gen_msh_via_meshcentral(mesh_group: str, out: Path) -> None:
    """Ask MeshCentral container to compute official agentCertificateHashHex + MeshServer."""
    Path("/tmp/wxqk_mesh_group.txt").write_text(mesh_group, encoding="utf-8")
    js = r"""
const fs = require('fs');
const path = require('path');
const forge = require(fs.existsSync('/opt/meshcentral/node_modules/node-forge')
  ? '/opt/meshcentral/node_modules/node-forge'
  : '/opt/meshcentral/meshcentral/node_modules/node-forge');
const dataDir = '/opt/meshcentral/meshcentral-data';
const cfg = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
const mesh = fs.readFileSync('/tmp/wxqk_mesh_group.txt', 'utf8').trim();
const agentPem = fs.readFileSync(path.join(dataDir, 'agentserver-cert-public.crt'), 'utf8');
const cert = forge.pki.certificateFromPem(agentPem);
const serverId = forge.pki.getPublicKeyFingerprint(cert.publicKey, {
  md: forge.md.sha384.create(),
  encoding: 'hex',
});
const host = (cfg.settings && cfg.settings.Cert) || process.env.HOSTNAME;
const agentPort = (cfg.settings && cfg.settings.AgentPort) || 4433;
// Production WXQK publishes AgentPortTls on AgentPort — agents must use that listener.
const meshServer = 'wss://' + host + ':' + agentPort + '/agent.ashx';
const lines = [
  'MeshName=WXQK Devices',
  'MeshType=2',
  'MeshID=' + mesh,
  'ServerID=' + serverId,
  'MeshServer=' + meshServer,
];
fs.writeFileSync('/tmp/WXQK.msh', lines.join('\n') + '\n');
console.log(JSON.stringify({ serverIdLen: serverId.length, meshServer, meshPrefix: mesh.slice(0, 8) }));
"""
    Path("/tmp/wxqk_official_msh.js").write_text(js, encoding="utf-8")
    subprocess.check_call(["docker", "cp", "/tmp/wxqk_mesh_group.txt", "wxqk-meshcentral:/tmp/wxqk_mesh_group.txt"])
    subprocess.check_call(["docker", "cp", "/tmp/wxqk_official_msh.js", "wxqk-meshcentral:/tmp/wxqk_official_msh.js"])
    meta = subprocess.check_output(
        ["docker", "exec", "wxqk-meshcentral", "node", "/tmp/wxqk_official_msh.js"],
        text=True,
    ).strip()
    print("MSH_META", meta)
    subprocess.check_call(["docker", "cp", "wxqk-meshcentral:/tmp/WXQK.msh", str(out)])
    text = out.read_text(encoding="utf-8", errors="replace")
    if not all(k in text for k in ("MeshServer=", "ServerID=", "MeshID=")):
        raise SystemExit("generated msh missing required fields")
    print(f"MSH_OK size={out.stat().st_size}")


def main() -> int:
    env = load_env()
    mesh = env.get("WXQK_MESH_GROUP") or ""
    if not mesh:
        print("FAIL WXQK_MESH_GROUP missing", file=sys.stderr)
        return 2
    out_dir = next((p for p in OUT_CANDIDATES if p.parent.exists() or p.exists()), OUT_CANDIDATES[0])
    out_dir.mkdir(parents=True, exist_ok=True)
    exe = out_dir / "WXQK.exe"
    msh = out_dir / "WXQK.msh"
    download_exe(exe)
    gen_msh_via_meshcentral(mesh, msh)
    # also mirror into admin-ui resources when running on prod host
    ui = REPO / "admin-ui" / "resources" / "meshcentral"
    if ui.parent.exists() and out_dir.resolve() != ui.resolve():
        ui.mkdir(parents=True, exist_ok=True)
        (ui / "WXQK.exe").write_bytes(exe.read_bytes())
        (ui / "WXQK.msh").write_text(msh.read_text(encoding="utf-8"), encoding="utf-8")
        print("MIRRORED", ui)
    print("DONE", out_dir)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
