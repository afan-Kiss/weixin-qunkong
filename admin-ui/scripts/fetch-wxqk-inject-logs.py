#!/usr/bin/env python3
"""从 wxqk 服务器拉取客户端同步日志中与 inject/DLL 相关的记录。

用法（PowerShell）:
  $env:WXQK_SSH_PASSWORD='***'
  python admin-ui/scripts/fetch-wxqk-inject-logs.py
"""
from __future__ import annotations

import json
import os
import sys

import paramiko

HOST = os.environ.get("WXQK_SSH_HOST", "47.108.21.50")
USER = os.environ.get("WXQK_SSH_USER", "root")
PASSWORD = os.environ.get("WXQK_SSH_PASSWORD") or ""

REMOTE_SCRIPT = r'''
import json, glob, os
files = sorted(glob.glob("/opt/wxqk/data/wx-sync/*.json"), key=os.path.getmtime, reverse=True)
print("FILE_COUNT", len(files))
keys = (
    "inject", "DLL", "注入", "启动微信", "微信实例", "新增微信",
    "get_group_member_contact", "get_contact", "群成员", "暂时无法取得资料",
    "添加好友", "加好友", "438557509",
)
for fp in files[:3]:
    data = json.load(open(fp, "r", encoding="utf-8"))
    print("FILE", os.path.basename(fp), "capturedAt", data.get("capturedAt"), "logs", len(data.get("logs") or []))
    found = []
    for row in data.get("logs") or []:
        blob = json.dumps(row, ensure_ascii=False)
        if any((k.lower() in blob.lower()) if k.isascii() else (k in blob) for k in keys):
            found.append(row)
    print("FOUND", len(found))
    for row in found[-40:]:
        print(json.dumps(row, ensure_ascii=False)[:1800])
        print("---")
'''


def main() -> int:
    if not PASSWORD:
        print("请设置环境变量 WXQK_SSH_PASSWORD 后再拉取服务器日志", file=sys.stderr)
        return 2
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, username=USER, password=PASSWORD, timeout=15, allow_agent=False, look_for_keys=False)
    _, stdout, stderr = client.exec_command("python3 - <<'PY'\n" + REMOTE_SCRIPT + "\nPY", timeout=90)
    sys.stdout.write(stdout.read().decode("utf-8", "replace"))
    err = stderr.read().decode("utf-8", "replace")
    if err.strip():
        sys.stderr.write(err)
    client.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
