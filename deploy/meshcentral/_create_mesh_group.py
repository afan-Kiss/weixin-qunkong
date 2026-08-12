#!/usr/bin/env python3
"""Create WXQK mesh group and prepare agent download URLs (no secrets printed)."""
from __future__ import annotations

import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

import paramiko

sys.stdout.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)


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
        print(f"+ {cmd[:220]}", flush=True)
        _i, o, e = c.exec_command(cmd, timeout=timeout, get_pty=True)
        out = o.read().decode("utf-8", "replace")
        code = o.channel.recv_exit_status()
        safe = "".join(ch for ch in out if not (0x2800 <= ord(ch) <= 0x28FF))
        safe = re.sub(r"\b[0-9a-fA-F]{48,}\b", "<hex>", safe)
        if safe.strip():
            print(safe[:12000], flush=True)
        if check and code != 0:
            raise SystemExit(f"fail {code}")
        return code, out

    run(
        "docker exec wxqk-meshcentral sh -c '"
        "node /opt/meshcentral/meshcentral/meshcentral.js --help 2>&1 | egrep -i \"create|mesh|account|user|agent|login\" | head -n 60'"
        ,
        check=False,
    )

    # List users / meshes via CLI if available
    for flag in ["--listuser", "--listusers", "--showusers", "--listmesh", "--listmeshes"]:
        run(
            f"docker exec wxqk-meshcentral sh -c 'node /opt/meshcentral/meshcentral/meshcentral.js {flag} 2>&1 | head -n 40'",
            check=False,
            timeout=60,
        )

    # Generate a short-lived login token ON THE SERVER using wired key + meshcentral_client if present
    run(
        "python3 - <<'PY'\n"
        "import os,sys\n"
        "from pathlib import Path\n"
        "# load env\n"
        "for ln in Path('/etc/wxqk/wxqk.env').read_text().splitlines():\n"
        "  if '=' in ln and not ln.startswith('#'):\n"
        "    k,v=ln.split('=',1); os.environ.setdefault(k,v)\n"
        "sys.path.insert(0,'/opt/wxqk')\n"
        "import meshcentral_client as mc\n"
        "tok=mc.create_login_token()\n"
        "print('TOKEN_LEN', len(tok))\n"
        "print('TOKEN_PREFIX', tok[:12]+'...')\n"
        "url=mc.build_embed_url(node_id='x', view='desktop', login_token=tok) if hasattr(mc,'build_embed_url') else ''\n"
        "print('PUBLIC', os.environ.get('WXQK_MESH_URL'))\n"
        "Path('/tmp/wxqk_mesh_login_token.txt').write_text(tok); Path('/tmp/wxqk_mesh_login_token.txt').chmod(0o600)\n"
        "print('TOKEN_FILE_OK')\n"
        "PY",
        check=False,
    )

    # Probe agent download endpoints (common ids) without auth
    run(
        "for id in 1 2 3 4 5 6 7 8 14 16; do "
        "code=$(curl -sk -o /dev/null -w '%{http_code}' --resolve 120.27.219.138:8444:127.0.0.1 "
        "'https://120.27.219.138:8444/meshagents?id='$id); "
        "echo id=$id code=$code; done",
        check=False,
    )

    # Check data files for mesh records
    run(
        "python3 - <<'PY'\n"
        "from pathlib import Path\n"
        "root=Path('/opt/wxqk/meshcentral/data')\n"
        "print('files', [str(p.relative_to(root)) for p in root.rglob('*') if p.is_file()][:80])\n"
        "PY",
        check=False,
    )
    c.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
