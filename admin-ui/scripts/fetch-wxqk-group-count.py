#!/usr/bin/env python3
import json, os, sys
import paramiko

HOST = os.environ.get("WXQK_SSH_HOST", "47.108.21.50")
USER = os.environ.get("WXQK_SSH_USER", "root")
PASSWORD = os.environ.get("WXQK_SSH_PASSWORD") or ""

def main() -> int:
    if not PASSWORD:
        print("缺少 WXQK_SSH_PASSWORD", file=sys.stderr)
        return 2
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(HOST, username=USER, password=PASSWORD, timeout=15, allow_agent=False, look_for_keys=False)
    script = r'''
import json,glob,os
files=sorted(glob.glob("/opt/wxqk/data/wx-sync/*.json"), key=os.path.getmtime, reverse=True)
for fp in files[:3]:
    d=json.load(open(fp,encoding="utf-8"))
    groups=d.get("groups") or []
    contacts=d.get("contacts") or []
    contact_groups=[x for x in contacts if str(x.get("wxid") or "").endswith("@chatroom") or x.get("isGroup")]
    print("FILE", os.path.basename(fp))
    print("capturedAt", d.get("capturedAt"))
    print("groups", len(groups))
    print("contact_groups", len(contact_groups))
    print("contacts_total", len(contacts))
    print("instances", [(i.get("nickname"), i.get("status"), i.get("accountWxid")) for i in (d.get("instances") or [])])
'''
    _, out, err = c.exec_command("python3 - <<'PY'\n" + script + "\nPY", timeout=60)
    sys.stdout.write(out.read().decode("utf-8", "replace"))
    sys.stderr.write(err.read().decode("utf-8", "replace"))
    c.close()
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
