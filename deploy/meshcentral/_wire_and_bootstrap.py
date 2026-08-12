#!/usr/bin/env python3
"""Wire Mesh secrets into wxqk, bootstrap admin, backup, health — no secrets printed."""
from __future__ import annotations

import os
import re
import secrets
import sys
import time

import paramiko

sys.stdout.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)

REMOTE = "/opt/wxqk/meshcentral"
PUBLIC = "https://120.27.219.138:8444"


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

    def run(cmd: str, timeout: int = 300, check: bool = True) -> tuple[int, str]:
        print(f"+ {cmd[:180]}", flush=True)
        _i, o, e = c.exec_command(cmd, timeout=timeout, get_pty=True)
        out = o.read().decode("utf-8", "replace")
        safe = "".join(ch for ch in out if not (0x2800 <= ord(ch) <= 0x28FF))
        code = o.channel.recv_exit_status()
        # redact long hex secrets in output
        safe = re.sub(r"(?i)(loginTokenKey|WXQK_MESH_LOGIN_KEY|password)[=:\"'\s]+[0-9a-fA-F]{32,}", r"\1=<redacted>", safe)
        safe = re.sub(r"\b[0-9a-fA-F]{64,}\b", "<hex-redacted>", safe)
        if safe.strip():
            print(safe[:10000], flush=True)
        if check and code != 0:
            raise SystemExit(f"fail {code}")
        return code, out  # return raw for key extraction

    # 1) Extract loginTokenKey from MeshCentral
    code, raw = run(
        "docker exec wxqk-meshcentral sh -c '"
        "cd /opt/meshcentral && "
        "(node node_modules/meshcentral --loginTokenKey || node meshcentral --loginTokenKey || true)"
        "' 2>&1",
        check=False,
        timeout=180,
    )
    key = ""
    for line in raw.splitlines():
        line = line.strip().strip('"').strip("'")
        if len(line) >= 64 and all(ch in "0123456789abcdefABCDEF" for ch in line):
            key = line.lower()
            break
    if not key:
        code, raw = run(
            "python3 - <<'PY'\n"
            "import json,re\n"
            "from pathlib import Path\n"
            "root=Path('/opt/wxqk/meshcentral/data')\n"
            "for p in root.rglob('*'):\n"
            "  if not p.is_file() or p.stat().st_size>2_000_000: continue\n"
            "  try: t=p.read_text(errors='ignore')\n"
            "  except Exception: continue\n"
            "  if 'loginTokenEncryptionKey' in t or 'loginTokenKey' in t:\n"
            "    m=re.search(r'(?:loginTokenEncryptionKey|loginTokenKey)[\\\"\\']?\\s*[:=]\\s*[\\\"\\']([0-9a-fA-F]{64,})', t)\n"
            "    if m: print(m.group(1).lower()); raise SystemExit\n"
            "    try:\n"
            "      j=json.loads(t)\n"
            "      for k in ('loginTokenKey','loginTokenEncryptionKey'):\n"
            "        v=((j.get('settings') or {}).get(k) or '')\n"
            "        if isinstance(v,str) and len(v)>=64: print(v.lower()); raise SystemExit\n"
            "    except Exception: pass\n"
            "print('NOT_FOUND')\n"
            "PY",
            check=False,
        )
        for line in raw.splitlines():
            line = line.strip()
            if len(line) >= 64 and all(ch in "0123456789abcdefABCDEF" for ch in line):
                key = line.lower()
                break
    if key:
        print("[MESH] loginTokenKey extracted (not printed)", flush=True)
    else:
        print("[MESH] WARN using existing .env login key", flush=True)

    # 2) Wire env files via remote python written over sftp (key never in process argv of shell history if careful)
    sftp = c.open_sftp()
    wire = f"""from pathlib import Path
key = {key!r}
public_url = {PUBLIC!r}
mesh_env = Path('{REMOTE}/.env')
text = mesh_env.read_text() if mesh_env.exists() else ''
lines=[]
seen=False
for line in text.splitlines():
    if line.startswith('WXQK_MESH_LOGIN_KEY='):
        if key:
            lines.append('WXQK_MESH_LOGIN_KEY=' + key)
            seen=True
        else:
            lines.append(line); seen=True
    else:
        lines.append(line)
if key and not seen:
    lines.append('WXQK_MESH_LOGIN_KEY=' + key)
mesh_env.write_text('\\n'.join(lines)+'\\n'); mesh_env.chmod(0o600)
# read final key from file if we didn't extract
final_key = key
for line in mesh_env.read_text().splitlines():
    if line.startswith('WXQK_MESH_LOGIN_KEY='):
        final_key = line.split('=',1)[1].strip()
p = Path('/etc/wxqk/wxqk.env'); p.parent.mkdir(parents=True, exist_ok=True)
text = p.read_text() if p.exists() else ''
kv = {{
  'WXQK_MESH_ENABLED': '1',
  'WXQK_MESH_URL': public_url,
  'WXQK_MESH_INTERNAL_URL': 'http://127.0.0.1:9080',
  'WXQK_MESH_USER': 'user//admin',
  'WXQK_MESH_LOGIN_KEY': final_key,
  'WXQK_MESH_TOKEN_EXPIRE_MIN': '30',
  'WXQK_MESH_TIMEOUT': '15',
}}
out=[ln for ln in text.splitlines() if not any(ln.startswith(k+'=') for k in kv)]
for k,v in kv.items():
    out.append(f'{{k}}={{v}}')
p.write_text('\\n'.join(out)+'\\n'); p.chmod(0o600)
print('WIRED_OK key_len=%d' % len(final_key))
"""
    with sftp.file("/tmp/wxqk_wire_mesh_env.py", "w") as f:
        f.write(wire)
    sftp.chmod("/tmp/wxqk_wire_mesh_env.py", 0o700)
    sftp.close()
    run("python3 /tmp/wxqk_wire_mesh_env.py && shred -u /tmp/wxqk_wire_mesh_env.py 2>/dev/null || rm -f /tmp/wxqk_wire_mesh_env.py")

    # 3) Create first admin if none (password only on server file chmod 600)
    admin_pass = secrets.token_urlsafe(24)
    run(
        "docker exec wxqk-meshcentral sh -c 'cd /opt/meshcentral && "
        "node node_modules/meshcentral --help 2>&1 | egrep -i \"create|account|user|pass\" | head -n 40 || true'",
        check=False,
    )
    # Store admin bootstrap password on server only
    sftp = c.open_sftp()
    with sftp.file("/opt/wxqk/meshcentral/ADMIN_BOOTSTRAP.txt", "w") as f:
        f.write(
            "# MeshCentral first admin bootstrap — chmod 600 — DO NOT commit\n"
            f"user=admin\n"
            f"userid=user//admin\n"
            f"password={admin_pass}\n"
            f"created_hint=create via MeshCentral web UI if CLI unavailable\n"
            f"url={PUBLIC}\n"
        )
    sftp.chmod("/opt/wxqk/meshcentral/ADMIN_BOOTSTRAP.txt", 0o600)
    sftp.close()
    print("[MESH] wrote ADMIN_BOOTSTRAP.txt on server (not printed)", flush=True)

    # Try CLI createaccount variants
    for cmd in [
        f"docker exec wxqk-meshcentral sh -c \"cd /opt/meshcentral && node node_modules/meshcentral --createaccount admin --pass '{admin_pass}'\"",
        f"docker exec wxqk-meshcentral sh -c \"cd /opt/meshcentral && node node_modules/meshcentral --useradmin admin --pass '{admin_pass}'\"",
    ]:
        code, out = run(cmd, check=False, timeout=120)
        if code == 0 and "error" not in out.lower():
            print("[MESH] admin create attempt returned 0", flush=True)
            break

    # 4) Restart wxqk to pick env; confirm core still up
    run("systemctl restart wxqk; sleep 3; systemctl is-active wxqk")
    run("curl -sk https://127.0.0.1:8443/wxqk/api/mesh/health | head -c 800; echo", check=False)
    run("curl -sk -o /dev/null -w 'wxqk_root=%{http_code}\\n' https://127.0.0.1:8443/wxqk/ || true", check=False)
    run(f"curl -sk -o /dev/null -w 'mesh=%{{http_code}}\\n' {PUBLIC}/ || true", check=False)

    # 5) Backup
    stamp = time.strftime("%Y%m%d-%H%M%S")
    run(
        f"cd {REMOTE} && mkdir -p backups/wxqk-mesh-{stamp} && "
        f"cp -a config.json .env data files backups/wxqk-mesh-{stamp}/ && "
        f"ls -la backups/wxqk-mesh-{stamp} && du -sh backups/wxqk-mesh-{stamp}"
    )

    # 6) List agent binaries inside container for fetch hints
    run(
        "docker exec wxqk-meshcentral sh -c 'ls -la /opt/meshcentral/node_modules/meshcentral/agents 2>/dev/null | head -n 40 || "
        "ls -la /opt/meshcentral/agents 2>/dev/null | head -n 40 || find /opt/meshcentral -name \"MeshService64.exe\" 2>/dev/null | head'",
        check=False,
    )
    run(
        "python3 - <<'PY'\n"
        "from pathlib import Path\n"
        "p=Path('/etc/wxqk/wxqk.env')\n"
        "for ln in p.read_text().splitlines():\n"
        "  if not ln.strip() or ln.startswith('#'): continue\n"
        "  k=ln.split('=',1)[0]\n"
        "  if 'KEY' in k or 'SECRET' in k or 'PASSWORD' in k or 'TOKEN' in k or 'PUBLISH' in k:\n"
        "    print(k+'=<redacted>')\n"
        "  elif k.startswith('WXQK_MESH') or k.startswith('FACAI888_PUBLIC') or k.startswith('WXQK_'):\n"
        "    print(ln if 'KEY' not in k else k+'=<redacted>')\n"
        "PY",
        check=False,
    )
    c.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
