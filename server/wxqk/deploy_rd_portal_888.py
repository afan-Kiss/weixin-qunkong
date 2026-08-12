#!/usr/bin/env python3
"""Screen-wall portal at :888 and https://xiangyuzhubao.xyz/888/."""
from __future__ import annotations

import os
import time

import paramiko

# 屏幕墙挂在旧域名机；独立环境变量，避免被 WXQK_SSH_HOST=新服 带偏
HOST = os.environ.get("RD_PORTAL_SSH_HOST") or "47.108.21.50"
USER = os.environ.get("RD_PORTAL_SSH_USER") or os.environ.get("WXQK_SSH_USER") or "root"
PASSWORD = (
    os.environ.get("RD_PORTAL_SSH_PASSWORD")
    or os.environ.get("WXQK_SSH_PASSWORD")
    or None
)

REMOTE_DIR = "/opt/rd-portal"
NGINX_SITE = "/etc/nginx/sites-enabled/rd-portal-888.conf"
BUSINESS_SNIPPET = "/etc/nginx/snippets/xiangyuzhubao-business.conf"
# 微信群控已迁到新服：旧域名屏幕墙经此反向代理看新服画面（同页聚合，无需再开 8443）
NEW_WXQK_UPSTREAM = "https://120.27.219.138:8443/wxqk/"
NEW_WXQK_DESK = "https://120.27.219.138:8443/wxqk/"  # remote desktop UI retired

# Single-file SPA: login → live thumbnail wall across wxqk / 九游 / 开云.
PORTAL_HTML = r"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>屏幕墙已退役</title>
  <style>
    body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
      font-family:"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif; background:#0b1220; color:#e8eef8; }
    .card { max-width:520px; padding:32px 28px; border:1px solid #243047; border-radius:14px; background:#121a2b; }
    h1 { margin:0 0 10px; font-size:22px; }
    p { margin:0; color:#8fa0b8; line-height:1.6; font-size:14px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>远程屏幕墙已退役</h1>
    <p>旧远程桌面屏幕墙已停用。请改用 MeshCentral 进行远程桌面管理。</p>
  </div>
</body>
</html>
"""

PROXY_COMMON = """\
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
"""

# 反代到新服 HTTPS（自签证书）：关闭校验，Host 用上游 IP:8443，保留 WS Upgrade
PROXY_REMOTE_WXQK = """\
        proxy_http_version 1.1;
        proxy_ssl_server_name on;
        proxy_ssl_verify off;
        proxy_ssl_name 120.27.219.138;
        proxy_set_header Host 120.27.219.138:8443;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
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
"""


def _proxy_block(location: str, upstream: str, *, remote_wxqk: bool = False) -> str:
    common = PROXY_REMOTE_WXQK if remote_wxqk else PROXY_COMMON
    return f"""    location ^~ {location} {{
        proxy_pass {upstream};
{common}    }}
"""


NGINX_PORT_CONF = f"""# Remote screen-wall on :888 (managed by deploy_rd_portal_888.py)
server {{
    listen 888;
    listen [::]:888;
    server_name _;
    client_max_body_size 250m;
    root {REMOTE_DIR};
    index index.html;

    location = / {{
        try_files /index.html =404;
        add_header Cache-Control "no-store";
    }}

{_proxy_block('/p/wxqk/', NEW_WXQK_UPSTREAM, remote_wxqk=True)}
{_proxy_block('/p/jiuyou/', 'http://127.0.0.1:4811/')}
{_proxy_block('/p/kaiyun/', 'http://127.0.0.1:4810/')}

    access_log /var/log/nginx/rd-portal-888.access.log;
    error_log /var/log/nginx/rd-portal-888.error.log;
}}
"""

# Inserted into xiangyuzhubao-business.conf for HTTPS/HTTP path /888/
NGINX_PATH_BLOCK = f"""# rd-portal /888 managed block
location = /888 {{
    return 301 /888/;
}}
location ^~ /888/p/wxqk/ {{
    proxy_pass {NEW_WXQK_UPSTREAM};
{PROXY_REMOTE_WXQK}}}
location ^~ /888/p/jiuyou/ {{
    proxy_pass http://127.0.0.1:4811/;
{PROXY_COMMON}}}
location ^~ /888/p/kaiyun/ {{
    proxy_pass http://127.0.0.1:4810/;
{PROXY_COMMON}}}
location ^~ /888/ {{
    alias {REMOTE_DIR}/;
    index index.html;
    add_header Cache-Control "no-store";
}}
# end rd-portal /888 managed block
"""


UPSERT_PATH_PY = f"""
from pathlib import Path
p = Path({BUSINESS_SNIPPET!r})
text = p.read_text(encoding='utf-8')
start = '# rd-portal /888 managed block'
end = '# end rd-portal /888 managed block'
# 清掉历史重复插入的整块
while True:
    a = text.find(start)
    if a < 0:
        break
    b = text.find(end, a)
    if b < 0:
        raise RuntimeError('incomplete /888 nginx block')
    text = text[:a] + text[b + len(end):].lstrip('\\r\\n')
block = {NGINX_PATH_BLOCK!r}
needle = 'client_max_body_size 200m;\\n'
if needle in text:
    text = text.replace(needle, needle + block, 1)
else:
    text = block + text
p.write_text(text, encoding='utf-8')
print('nginx /888 path block upserted')
"""


def main() -> None:
    if not HOST:
        raise SystemExit("RD_PORTAL_SSH_HOST is required")
    if not PASSWORD:
        raise SystemExit("RD_PORTAL_SSH_PASSWORD or WXQK_SSH_PASSWORD is required (set env var, do NOT hardcode)")
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(
        HOST,
        username=USER,
        password=PASSWORD,
        timeout=20,
        allow_agent=False,
        look_for_keys=False,
    )

    def run(command: str) -> str:
        _, stdout, stderr = client.exec_command(command, timeout=90)
        out = stdout.read().decode("utf-8", "replace")
        err = stderr.read().decode("utf-8", "replace")
        print("$", command[:120])
        if out.strip():
            print(out[:2500])
        if err.strip():
            print("ERR", err[:1000])
        return out

    run(f"mkdir -p {REMOTE_DIR}")
    sftp = client.open_sftp()
    with sftp.file(f"{REMOTE_DIR}/index.html", "w") as f:
        f.write(PORTAL_HTML)
    with sftp.file(f"{REMOTE_DIR}/rd-portal-888.conf", "w") as f:
        f.write(NGINX_PORT_CONF)
    with sftp.file(f"{REMOTE_DIR}/_upsert_nginx_888_path.py", "w") as f:
        f.write(UPSERT_PATH_PY)
    sftp.close()

    run(f"cp {REMOTE_DIR}/rd-portal-888.conf {NGINX_SITE}")
    run(f"python3 {REMOTE_DIR}/_upsert_nginx_888_path.py")
    run("nginx -t && systemctl reload nginx")
    time.sleep(0.4)

    run("ss -lntp | grep ':888 ' || true")
    checks = [
        ("portal888", "http://127.0.0.1:888/"),
        ("path888", "http://127.0.0.1/888/", "xiangyuzhubao.xyz"),
        ("p_wxqk", "http://127.0.0.1:888/p/wxqk/"),
        ("p_jiuyou", "http://127.0.0.1:888/p/jiuyou/"),
        ("p_kaiyun", "http://127.0.0.1:888/p/kaiyun/"),
        ("path_p_wxqk", "http://127.0.0.1/888/p/wxqk/", "xiangyuzhubao.xyz"),
    ]
    for item in checks:
        name, url = item[0], item[1]
        host = item[2] if len(item) > 2 else None
        hdr = f"-H 'Host: {host}' " if host else ""
        run(f"curl -sS -o /dev/null -w '{name} %{{http_code}}\\n' {hdr}{url}")

    # 确认屏幕墙 /p/wxqk 已打到新服（仅检查端口可达，不在代码中嵌入密码）
    run(
        "curl -sS -o /dev/null -w 'wxqk_proxy %{http_code}\\n' 'http://127.0.0.1:888/p/wxqk/api/login'"
    )
    run(
        "curl -sS -o /dev/null -w 'wxqk_domain %{http_code}\\n' "
        "-H 'Host: xiangyuzhubao.xyz' 'http://127.0.0.1/888/p/wxqk/api/login'"
    )

    client.close()
    print(f"done → http://{HOST}:888/  and  https://xiangyuzhubao.xyz/888/")


if __name__ == "__main__":
    main()
