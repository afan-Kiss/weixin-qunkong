#!/usr/bin/env python3
"""Enable HTTPS (IP:8443) for wxqk on a greenfield host and refresh portal/manifest."""
from __future__ import annotations

import json
import os
import time
from pathlib import Path

import paramiko

from deploy import EXTRA_PY
from deploy_rd_portal_888 import NGINX_PORT_CONF, PORTAL_HTML

HOST = os.environ.get("WXQK_SSH_HOST", "120.27.219.138")
USER = os.environ.get("WXQK_SSH_USER", "root")
PASSWORD = os.environ.get("WXQK_SSH_PASSWORD") or None
PUBLIC_HTTPS = os.environ.get("WXQK_PUBLIC_HTTPS", f"https://{HOST}:8443/wxqk").rstrip("/")
HERE = Path(__file__).resolve().parent
REMOTE = "/opt/wxqk"
PORTAL = "/opt/rd-portal"

UPLOAD = [
    "server.py", "admin_ui.py", "chat_media.py", "road_archive.py", "sim_bets.py",
    "wsutil.py", "text_rotate.py", *EXTRA_PY,
]

NGINX_HTTPS = f"""# wxqk HTTPS IP endpoint :8443
server {{
    listen 8443 ssl http2;
    listen [::]:8443 ssl http2;
    server_name _;
    client_max_body_size 250m;

    ssl_certificate     /etc/nginx/ssl/wxqk-ip.crt;
    ssl_certificate_key /etc/nginx/ssl/wxqk-ip.key;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         HIGH:!aNULL:!MD5;

    location = /wxqk {{
        return 301 /wxqk/;
    }}
    location ^~ /wxqk/ {{
        proxy_pass http://127.0.0.1:4812/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_connect_timeout 60s;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        client_body_timeout 600s;
        client_max_body_size 250m;
        proxy_request_buffering off;
        proxy_buffering off;
        # 大文件下载：关闭缓冲、拉长超时，让客户端尽量吃满上行带宽
        proxy_max_temp_file_size 0;
        sendfile on;
        tcp_nopush on;
        tcp_nodelay on;
        add_header Cache-Control "no-store";
    }}
}}
"""

UNIT = f"""[Unit]
Description=WeChat QunKong remote board (wxqk)
After=network.target

[Service]
Type=simple
WorkingDirectory={REMOTE}
Environment=WXQK_PORT=4812
Environment=WXQK_BIND=127.0.0.1
Environment=WXQK_DATA={REMOTE}/data
EnvironmentFile=-/etc/wxqk/wxqk.env
Environment=FACAI888_PORT=4812
Environment=FACAI888_BIND=127.0.0.1
Environment=FACAI888_DATA={REMOTE}/data
Environment=FACAI888_PUBLIC_PREFIX=/wxqk
Environment=FACAI888_PUBLIC_BASE_URL={PUBLIC_HTTPS}
Environment=FACAI888_AUTO_ACTIVATE_DEVICES=1
Environment=FACAI888_PUBLISH_KEY_B64=TIwR8GPTQsAO49IXWjfXok0xHouoHGFbkTsi5B4Pf9A=
# TURN secrets live in EnvironmentFile=/etc/wxqk/wxqk.env (see deploy_turn.py)
ExecStart=/usr/bin/python3 {REMOTE}/server.py
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
"""


def main() -> None:
    if not PASSWORD:
        raise SystemExit("WXQK_SSH_PASSWORD required")
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(HOST, username=USER, password=PASSWORD, timeout=30, allow_agent=False, look_for_keys=False)

    def run(cmd: str, timeout: int = 180) -> str:
        _, o, e = c.exec_command(cmd, timeout=timeout)
        out = o.read().decode("utf-8", "replace")
        err = e.read().decode("utf-8", "replace")
        print("$", cmd[:140])
        if out.strip():
            print(out[:3000])
        if err.strip():
            print("ERR", err[:1500])
        return out

    sftp = c.open_sftp()
    for name in UPLOAD:
        local = HERE / name
        if local.exists():
            sftp.put(str(local), f"{REMOTE}/{name}")
            print("uploaded", name)
    with sftp.file(f"{REMOTE}/wxqk.service", "w") as f:
        f.write(UNIT)
    with sftp.file(f"{PORTAL}/index.html", "w") as f:
        f.write(PORTAL_HTML)
    with sftp.file(f"{PORTAL}/rd-portal-888.conf", "w") as f:
        f.write(NGINX_PORT_CONF)
    with sftp.file("/etc/nginx/sites-available/wxqk-https-8443.conf", "w") as f:
        f.write(NGINX_HTTPS)
    sftp.close()

    run("mkdir -p /etc/nginx/ssl")
    run(
        "if [ ! -s /etc/nginx/ssl/wxqk-ip.crt ]; then "
        f"openssl req -x509 -nodes -newkey rsa:2048 -days 3650 "
        f"-keyout /etc/nginx/ssl/wxqk-ip.key -out /etc/nginx/ssl/wxqk-ip.crt "
        f"-subj '/CN={HOST}' "
        f"-addext 'subjectAltName=IP:{HOST}'; fi; "
        "openssl x509 -in /etc/nginx/ssl/wxqk-ip.crt -noout -subject -dates; "
        "echo '--- SPKI PIN (for WXQK_TLS_SPKI_PINS) ---'; "
        "openssl x509 -in /etc/nginx/ssl/wxqk-ip.crt -pubkey -noout | "
        "openssl pkey -pubin -outform der 2>/dev/null | "
        "openssl dgst -sha256 -binary | base64 | "
        "xargs -I{} echo 'sha256/{}'"
    )
    # ensure map exists in http context (already in wxqk.conf for greenfield)
    run("grep -q 'map $http_upgrade $connection_upgrade' /etc/nginx/sites-available/wxqk.conf || "
        "sed -i '1i map $http_upgrade $connection_upgrade { default upgrade; \\'\\'\\' close; }' /etc/nginx/sites-available/wxqk.conf")
    run("ln -sfn /etc/nginx/sites-available/wxqk-https-8443.conf /etc/nginx/sites-enabled/wxqk-https-8443.conf")
    run(f"cp {PORTAL}/rd-portal-888.conf /etc/nginx/sites-enabled/rd-portal-888.conf")
    run("cp /opt/wxqk/wxqk.service /etc/systemd/system/wxqk.service")
    run("systemctl daemon-reload && systemctl restart wxqk.service")
    time.sleep(1)
    run("nginx -t && systemctl reload nginx")
    run("ufw allow 8443/tcp 2>/dev/null || true")

    # rewrite release-manifest downloadURL to HTTPS IP endpoint
    run(
        "python3 - <<'PY'\n"
        "import json\n"
        "from pathlib import Path\n"
        f"base={PUBLIC_HTTPS!r}\n"
        "p=Path('/opt/wxqk/data/releases/release-manifest.json')\n"
        "if p.exists():\n"
        "  m=json.loads(p.read_text(encoding='utf-8'))\n"
        "  bid=str(m.get('buildId') or '')\n"
        "  if bid:\n"
        "    m['downloadURL']=f\"{base}/api/update/package/{bid}\"\n"
        "    p.write_text(json.dumps(m, ensure_ascii=False, indent=2)+'\\n', encoding='utf-8')\n"
        "    print('manifest downloadURL', m['downloadURL'])\n"
        "tp=Path('/opt/wxqk/data/releases/targeted-releases.json')\n"
        "if tp.exists():\n"
        "  try:\n"
        "    t=json.loads(tp.read_text(encoding='utf-8'))\n"
        "  except Exception:\n"
        "    t=None\n"
        "  changed=False\n"
        "  if isinstance(t, dict):\n"
        "    rows=t.get('releases') or t.get('items') or []\n"
        "    if isinstance(rows, list):\n"
        "      for row in rows:\n"
        "        if not isinstance(row, dict): continue\n"
        "        bid=str(row.get('buildId') or '')\n"
        "        if bid and 'downloadURL' in row:\n"
        "          row['downloadURL']=f\"{base}/api/update/package/{bid}\"; changed=True\n"
        "    if changed:\n"
        "      tp.write_text(json.dumps(t, ensure_ascii=False, indent=2)+'\\n', encoding='utf-8')\n"
        "      print('targeted urls rewritten')\n"
        "PY"
    )

    run("curl -skS -o /dev/null -w 'https8443 %{http_code}\\n' https://127.0.0.1:8443/wxqk/")
    # 仅检查端口可达，不在代码中嵌入密码
    run("curl -skS -o /dev/null -w 'login %{http_code}\\n' -X POST https://127.0.0.1:8443/wxqk/api/login "
        "-H 'Content-Type: application/json' -d '{}'")
    # NOTE: 仓库历史出现过的真实凭据必须人工轮换
    run("curl -skS https://127.0.0.1:8443/wxqk/api/update/manifest | head -c 280; echo")
    run("ss -lntp | grep -E ':8443|:80|:888|:4812' | head -20")
    c.close()
    print("HTTPS ready →", PUBLIC_HTTPS)


if __name__ == "__main__":
    main()
