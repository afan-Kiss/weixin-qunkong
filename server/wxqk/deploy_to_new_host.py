#!/usr/bin/env python3
"""Greenfield deploy of wxqk admin+agent backend and 888 screen wall to a fresh host.

Usage:
  set WXQK_SSH_HOST / WXQK_SSH_PASSWORD / WXQK_SITE_PASSWORD
  optionally WXQK_PUBLIC_BASE (default http://HOST/wxqk)
  py -3 deploy_to_new_host.py
"""
from __future__ import annotations

import json
import os
import time
from pathlib import Path

import paramiko

from deploy import EXTRA_PY, VERSION_POLICY
from deploy_rd_portal_888 import NGINX_PORT_CONF, PORTAL_HTML

HERE = Path(__file__).resolve().parent
HOST = os.environ.get("WXQK_SSH_HOST", "").strip()
USER = os.environ.get("WXQK_SSH_USER", "root")
PASSWORD = os.environ.get("WXQK_SSH_PASSWORD") or None
SITE_PASSWORD = (os.environ.get("WXQK_SITE_PASSWORD") or "").strip()
PUBLIC_BASE = os.environ.get("WXQK_PUBLIC_BASE", "").strip()
SYNC_FROM = os.environ.get("WXQK_SYNC_FROM", "").strip()  # optional old host to pull releases
SYNC_PASS = os.environ.get("WXQK_SYNC_PASSWORD") or None

REMOTE_DIR = "/opt/wxqk"
PORTAL_DIR = "/opt/rd-portal"
SERVICE = "wxqk"
PORT = 4812
PUBLIC_PREFIX = "/wxqk"

UPLOAD_FILES = [
    "server.py",
    "admin_ui.py",
    "chat_media.py",
    "road_archive.py",
    "sim_bets.py",
    "wsutil.py",
    "text_rotate.py",
    *EXTRA_PY,
]


def _require() -> None:
    if not HOST:
        raise SystemExit("WXQK_SSH_HOST is required")
    if not PASSWORD:
        raise SystemExit("WXQK_SSH_PASSWORD is required")
    if not SITE_PASSWORD:
        raise SystemExit("WXQK_SITE_PASSWORD is required")


def _public_base() -> str:
    if PUBLIC_BASE:
        return PUBLIC_BASE.rstrip("/")
    return f"http://{HOST}{PUBLIC_PREFIX}"


def _unit() -> str:
    base = _public_base()
    return f"""[Unit]
Description=WeChat QunKong remote board (wxqk)
After=network.target

[Service]
Type=simple
WorkingDirectory={REMOTE_DIR}
Environment=WXQK_PORT={PORT}
Environment=WXQK_BIND=127.0.0.1
Environment=WXQK_DATA={REMOTE_DIR}/data
EnvironmentFile=-/etc/wxqk/wxqk.env
EnvironmentFile=-/etc/wxqk/mesh.env
Environment=FACAI888_PORT={PORT}
Environment=FACAI888_BIND=127.0.0.1
Environment=FACAI888_DATA={REMOTE_DIR}/data
Environment=FACAI888_PUBLIC_PREFIX={PUBLIC_PREFIX}
Environment=FACAI888_PUBLIC_BASE_URL={base}
Environment=FACAI888_AUTO_ACTIVATE_DEVICES=1
Environment=FACAI888_PUBLISH_KEY_B64=TIwR8GPTQsAO49IXWjfXok0xHouoHGFbkTsi5B4Pf9A=
ExecStart=/usr/bin/python3 {REMOTE_DIR}/server.py
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
"""


NGINX_DEFAULT = f"""# wxqk greenfield site (managed by deploy_to_new_host.py)
map $http_upgrade $connection_upgrade {{
    default upgrade;
    '' close;
}}

server {{
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;
    client_max_body_size 250m;

    location = / {{
        return 302 {PUBLIC_PREFIX}/;
    }}

    location = {PUBLIC_PREFIX} {{
        return 301 {PUBLIC_PREFIX}/;
    }}
    location ^~ {PUBLIC_PREFIX}/ {{
        proxy_pass http://127.0.0.1:{PORT}/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_connect_timeout 60s;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        client_body_timeout 600s;
        client_max_body_size 250m;
        proxy_request_buffering off;
        proxy_buffering off;
        add_header Cache-Control "no-store";
    }}

    location = /888 {{
        return 301 /888/;
    }}
    location ^~ /888/p/wxqk/ {{
        proxy_pass http://127.0.0.1:{PORT}/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_connect_timeout 60s;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        client_body_timeout 600s;
        client_max_body_size 250m;
        proxy_request_buffering off;
        proxy_buffering off;
        add_header Cache-Control "no-store";
    }}
    # Keep aliases for portal UI (boards may be absent on this host).
    location ^~ /888/p/jiuyou/ {{
        proxy_pass http://127.0.0.1:4811/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 3600s;
    }}
    location ^~ /888/p/kaiyun/ {{
        proxy_pass http://127.0.0.1:4810/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 3600s;
    }}
    location ^~ /888/ {{
        alias {PORTAL_DIR}/;
        index index.html;
        add_header Cache-Control "no-store";
    }}
}}
"""

# Minimal snippet so legacy deploy_wxqk / portal upsert scripts do not crash.
SNIPPET_SEED = "    client_max_body_size 200m;\n"


def main() -> None:
    _require()
    base = _public_base()
    print(f"deploy target={HOST} public_base={base}")

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, username=USER, password=PASSWORD, timeout=30, allow_agent=False, look_for_keys=False)

    def run(command: str, timeout: int = 300) -> str:
        _, stdout, stderr = client.exec_command(command, timeout=timeout)
        out = stdout.read().decode("utf-8", "replace")
        err = stderr.read().decode("utf-8", "replace")
        # Redact secrets from logged command
        logged = command[:160]
        for s in [PASSWORD or "", SITE_PASSWORD or "", SYNC_PASS or ""]:
            if s and len(s) > 3:
                logged = logged.replace(s, "****")
        print("$", logged)
        if out.strip():
            print(out[:4000])
        if err.strip():
            print("ERR", err[:2000])
        return out

    # --- packages ---
    run(
        "export DEBIAN_FRONTEND=noninteractive; "
        "apt-get update -qq && "
        "apt-get install -y -qq nginx python3-pip python3-venv openssh-client rsync > /tmp/apt-wxqk.log 2>&1; "
        "tail -n 5 /tmp/apt-wxqk.log; "
        "nginx -v 2>&1; python3 --version"
    )
    run("python3 -m pip install -q 'cryptography>=41' 'paramiko>=3' 2>/dev/null || pip3 install -q 'cryptography>=41' 'paramiko>=3'")

    # --- dirs / nginx skeleton ---
    run(f"mkdir -p {REMOTE_DIR}/data/media {REMOTE_DIR}/data/releases/packages {PORTAL_DIR} /etc/wxqk /etc/nginx/snippets /var/log/nginx")
    run("rm -f /etc/nginx/sites-enabled/default")

    sftp = client.open_sftp()
    with sftp.file("/etc/nginx/sites-available/wxqk.conf", "w") as f:
        f.write(NGINX_DEFAULT)
    with sftp.file("/etc/nginx/snippets/xiangyuzhubao-business.conf", "w") as f:
        f.write(SNIPPET_SEED)
    with sftp.file(f"{REMOTE_DIR}/{SERVICE}.service", "w") as f:
        f.write(_unit())
    with sftp.file("/etc/wxqk/wxqk.env", "w") as f:
        f.write(
            f"WXQK_PASSWORD={SITE_PASSWORD}\n"
            f"FACAI888_PASSWORD={SITE_PASSWORD}\n"
        )
    sftp.chmod("/etc/wxqk/wxqk.env", 0o600)

    for name in UPLOAD_FILES:
        local = HERE / name
        if not local.exists():
            print("MISSING", name)
            continue
        sftp.put(str(local), f"{REMOTE_DIR}/{name}")
        print("uploaded", name)

    policy_path = f"{REMOTE_DIR}/data/version_policy.json"
    try:
        sftp.stat(policy_path)
        print("keep existing version_policy.json")
    except OSError:
        with sftp.file(policy_path, "w") as f:
            f.write(json.dumps(VERSION_POLICY, ensure_ascii=False, indent=2))
        print("seeded version_policy.json")

    # portal
    with sftp.file(f"{PORTAL_DIR}/index.html", "w") as f:
        f.write(PORTAL_HTML)
    with sftp.file(f"{PORTAL_DIR}/rd-portal-888.conf", "w") as f:
        f.write(NGINX_PORT_CONF)
    sftp.close()

    run("ln -sfn /etc/nginx/sites-available/wxqk.conf /etc/nginx/sites-enabled/wxqk.conf")
    run(f"cp {PORTAL_DIR}/rd-portal-888.conf /etc/nginx/sites-enabled/rd-portal-888.conf")
    run(f"cd {REMOTE_DIR} && python3 -c \"import server, chat_media, client_gate, devices; print('imports ok')\"")
    run(f"cp {REMOTE_DIR}/{SERVICE}.service /etc/systemd/system/{SERVICE}.service")
    run("systemctl daemon-reload")
    run(f"systemctl enable --now {SERVICE}.service")
    run(f"systemctl restart {SERVICE}.service")
    time.sleep(1)
    run(f"systemctl --no-pager --full status {SERVICE}.service | head -20")
    run("nginx -t && systemctl enable --now nginx && systemctl reload nginx")

    # health
    run(f"curl -fsS http://127.0.0.1:{PORT}/ >/dev/null && echo local_wxqk_ok")
    run("curl -sS -o /dev/null -w 'http_wxqk %{http_code}\\n' http://127.0.0.1/wxqk/")
    run("curl -sS -o /dev/null -w 'portal888 %{http_code}\\n' http://127.0.0.1:888/")
    run("curl -sS -o /dev/null -w 'path888 %{http_code}\\n' http://127.0.0.1/888/")
    run("curl -sS -o /dev/null -w 'p_wxqk %{http_code}\\n' http://127.0.0.1:888/p/wxqk/")

    # optional: pull releases from old host so software update channel works
    if SYNC_FROM and SYNC_PASS:
        print(f"syncing releases from {SYNC_FROM} ...")
        # install sshpass if available, else use paramiko on remote via python
        sync_py = r'''
import os, tarfile, io, tempfile
import paramiko
src_host = os.environ["SRC_HOST"]
src_pass = os.environ["SRC_PASS"]
c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(src_host, username="root", password=src_pass, timeout=30, allow_agent=False, look_for_keys=False)
sftp = c.open_sftp()
# always sync manifests + keys + latest package referenced by manifest
remote_root = "/opt/wxqk/data/releases"
local_root = "/opt/wxqk/data/releases"
os.makedirs(local_root + "/packages", exist_ok=True)
for name in ["release-manifest.json", "release-manifest.sig", "targeted-releases.json", "publish_ed25519.priv", "update-events.jsonl"]:
    try:
        sftp.get(f"{remote_root}/{name}", f"{local_root}/{name}")
        print("got", name)
    except Exception as e:
        print("skip", name, e)
# parse latest buildId
import json
from pathlib import Path
man = json.loads(Path(local_root + "/release-manifest.json").read_text(encoding="utf-8"))
build = str(man.get("buildId") or man.get("latestBuildId") or "")
print("manifest build", build, "version", man.get("version"))
# copy that package + a few recent .exe (cap ~800MB)
pkgs = sorted(sftp.listdir_attr(remote_root + "/packages"), key=lambda a: a.st_mtime, reverse=True)
copied = 0
budget = 900 * 1024 * 1024
for attr in pkgs:
    name = attr.filename
    if not (name.endswith(".exe") or name.endswith(".meta.json") or name.endswith(".sig")):
        continue
    if name.endswith(".partial") or name.endswith(".upload.json"):
        continue
    size = attr.st_size or 0
    if copied + size > budget and copied > 0 and not name.startswith(build):
        continue
    if build and (name.startswith(build) or name.endswith(".meta.json")):
        pass
    elif copied > 350 * 1024 * 1024 and not name.startswith(build):
        continue
    local = f"{local_root}/packages/{name}"
    if os.path.exists(local) and os.path.getsize(local) == size:
        print("exists", name)
        continue
    print("fetch", name, size)
    sftp.get(f"{remote_root}/packages/{name}", local)
    copied += size
print("copied_bytes", copied)
# version policy if present
try:
    sftp.get("/opt/wxqk/data/version_policy.json", "/opt/wxqk/data/version_policy.json")
    print("got version_policy.json")
except Exception as e:
    print("policy skip", e)
sftp.close(); c.close()
print("sync done")
'''
        sftp = client.open_sftp()
        with sftp.file("/tmp/sync_wxqk_releases.py", "w") as f:
            f.write(sync_py)
        # Write credentials to a temp 0600 file instead of shell env (avoids log leakage)
        cred_json = json.dumps({"host": SYNC_FROM, "password": SYNC_PASS})
        with sftp.file("/tmp/.wxqk_sync_cred.json", "w") as f:
            f.write(cred_json)
        sftp.close()
        run("chmod 600 /tmp/.wxqk_sync_cred.json", timeout=10)
        run(
            "SRC_HOST=$(python3 -c \"import json;print(json.load(open('/tmp/.wxqk_sync_cred.json'))['host'])\"); "
            "SRC_PASS=$(python3 -c \"import json;print(json.load(open('/tmp/.wxqk_sync_cred.json'))['password'])\"); "
            "export SRC_HOST SRC_PASS; python3 /tmp/sync_wxqk_releases.py; "
            "rm -f /tmp/.wxqk_sync_cred.json",
            timeout=1800,
        )
        run(f"systemctl restart {SERVICE}.service")
        time.sleep(1)

    run("ufw allow 80/tcp 2>/dev/null || true; ufw allow 888/tcp 2>/dev/null || true; ufw status 2>/dev/null | head -20 || true")
    client.close()
    print()
    print("=== deploy complete ===")
    print(f"系统后台(管理台):  http://{HOST}/wxqk/   （站点密码已通过环境变量配置）")
    print(f"软件后台(API/WS):  {base}/   （客户端需指向该地址）")
    print(f"屏幕墙:            http://{HOST}:888/  或  http://{HOST}/888/")
    print("登录页用管理密码；软件连接同一 /wxqk 前缀。")


if __name__ == "__main__":
    main()
