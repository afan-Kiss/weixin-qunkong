#!/usr/bin/env python3
"""Upload gen_msh.js, produce meshagent.msh, confirm Windows exe."""
from __future__ import annotations

import os
import re
import sys
from pathlib import Path

import paramiko

sys.stdout.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
HERE = Path(__file__).resolve().parent


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
    sftp.put(str(HERE / "_gen_msh.js"), "/tmp/gen_msh.js")

    def run(cmd: str, timeout: int = 180) -> tuple[int, str]:
        print("+", cmd[:200], flush=True)
        _i, o, e = c.exec_command(cmd, timeout=timeout, get_pty=True)
        out = o.read().decode("utf-8", "replace")
        code = o.channel.recv_exit_status()
        print(re.sub(r"\b[0-9a-fA-F]{40,}\b", "<hex>", out)[:12000], flush=True)
        return code, out

    run("docker cp /tmp/gen_msh.js wxqk-meshcentral:/tmp/gen_msh.js")
    run(
        "python3 - <<'PY'\n"
        "from pathlib import Path\n"
        "mesh=''\n"
        "for ln in Path('/etc/wxqk/wxqk.env').read_text().splitlines():\n"
        "  if ln.startswith('WXQK_MESH_GROUP='): mesh=ln.split('=',1)[1].strip()\n"
        "print(mesh)\n"
        "Path('/tmp/mesh_id.txt').write_text(mesh)\n"
        "PY"
    )
    # ensure exe
    run(
        "mkdir -p /opt/wxqk/meshcentral/agent-staging && "
        "if [ ! -s /opt/wxqk/meshcentral/agent-staging/meshagent.exe ]; then "
        "curl -s http://127.0.0.1:9443/meshagents?id=3 -o /opt/wxqk/meshcentral/agent-staging/meshagent.exe; fi && "
        "python3 -c \"p=open('/opt/wxqk/meshcentral/agent-staging/meshagent.exe','rb').read(2); import os; print('EXE',os.path.getsize('/opt/wxqk/meshcentral/agent-staging/meshagent.exe'),p)\""
    )
    # try mesh id forms
    code, out = run(
        "MID=$(cat /tmp/mesh_id.txt); LEAF=${MID#mesh//}; "
        "python3 - <<'PY'\n"
        "import base64, pathlib\n"
        "mid=pathlib.Path('/tmp/mesh_id.txt').read_text().strip()\n"
        "leaf=mid.split('//')[-1]\n"
        "cands=[mid, leaf]\n"
        "try:\n"
        "  raw=base64.b64decode(leaf+'==', altchars=b'@$')\n"
        "  cands.append('0x'+raw.hex())\n"
        "except Exception as e:\n"
        "  print('b64',e)\n"
        "pathlib.Path('/tmp/mesh_cands.txt').write_text('\\n'.join(cands))\n"
        "print('cands', len(cands))\n"
        "PY"
    )
    run(
        "ok=0; "
        "while read -r MID; do "
        "  for MS in 'wss://120.27.219.138:4433/agent.ashx' 'wss://120.27.219.138:8444/agent.ashx'; do "
        "    echo TRY \"$MID\" \"$MS\"; "
        "    if docker exec -e MID=\"$MID\" -e MS=\"$MS\" wxqk-meshcentral node /tmp/gen_msh.js; then "
        "      docker cp wxqk-meshcentral:/tmp/out.msh /opt/wxqk/meshcentral/agent-staging/meshagent.msh; "
        "      SID=$(grep '^ServerID=' /opt/wxqk/meshcentral/agent-staging/meshagent.msh | head -n1 | cut -d= -f2-); "
        "      if [ -n \"$SID\" ]; then echo MSH_OK; ok=1; "
        "        grep -E '^(MeshName|MeshServer|MeshID|ServerID)=' /opt/wxqk/meshcentral/agent-staging/meshagent.msh | sed -E 's/(ServerID=).*/\\1<redacted-len:'${\"#SID\"}'/; s/(MeshID=).{20}/\\1.../'; "
        "        break 2; fi; "
        "    fi; "
        "  done; "
        "done < /tmp/mesh_cands.txt; "
        "ls -la /opt/wxqk/meshcentral/agent-staging/; "
        "test \"$ok\" = 1"
    )
    # Also dump hash helper names
    run(
        "docker exec wxqk-meshcentral node -e \"const c=require('/opt/meshcentral/meshcentral/common.js');"
        "console.log(Object.keys(c).filter(k=>/hash|cert|Hash|Cert/.test(k)).join(','))\""
    )
    c.close()
    sftp.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
