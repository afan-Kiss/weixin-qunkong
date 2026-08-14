#!/usr/bin/env python3
"""Deploy wxqk remote board (port 4812 behind :8443).

域名机只做入口反代；远控走独立 MeshCentral，不再部署旧自研远控栈。
"""
from __future__ import annotations

import json
import os
import time
from pathlib import Path

import paramiko

from deploy import EXTRA_PY, PASSWORD, USER, VERSION_POLICY

HERE = Path(__file__).resolve().parent
HOST = os.environ.get("WXQK_SSH_HOST", "").strip() or "203.0.113.10"
REMOTE_DIR = "/opt/wxqk"
SERVICE = "wxqk"
PORT = 4812
SITE_PASSWORD = os.environ.get("WXQK_SITE_PASSWORD") or None
PUBLIC_PREFIX = "/wxqk"
UNIT = f"""[Unit]
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
# PUBLIC_BASE_URL must be set in /etc/wxqk/wxqk.env (production fail-closed; no placeholder).
Environment=FACAI888_AUTO_ACTIVATE_DEVICES=0
Environment=WXQK_DEVICE_AUTO_ACTIVATE=0
# Publish private seed ONLY via EnvironmentFile=/etc/wxqk/wxqk.env (0600). Never hardcode in Git.
ExecStart=/usr/bin/python3 {REMOTE_DIR}/server.py
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
"""

NGINX_BLOCK = f"""# wxqk managed block
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
    proxy_request_buffering on;
    proxy_buffering on;
    add_header Cache-Control "no-store";
}}
# end wxqk managed block
"""

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


def main() -> None:
    client = paramiko.SSHClient()
    from ssh_host_key import configure_ssh_client
    configure_ssh_client(client)
    client.connect(HOST, username=USER, password=PASSWORD, timeout=20, allow_agent=PASSWORD is None, look_for_keys=PASSWORD is None)

    def run(command: str) -> str:
        _, stdout, stderr = client.exec_command(command, timeout=120)
        out = stdout.read().decode("utf-8", "replace")
        err = stderr.read().decode("utf-8", "replace")
        print("$", command)
        if out.strip():
            print(out[:2000])
        if err.strip():
            print("ERR", err[:1000])
        return out

    run(f"mkdir -p {REMOTE_DIR}/data/media")
    run("install -d -m 700 /etc/wxqk")
    sftp = client.open_sftp()
    for name in UPLOAD_FILES:
        local = HERE / name
        if local.exists():
            sftp.put(str(local), f"{REMOTE_DIR}/{name}")
            print("uploaded", name)
        else:
            print("MISSING", name)

    policy_path = f"{REMOTE_DIR}/data/version_policy.json"
    try:
        sftp.stat(policy_path)
        print("keep existing version_policy.json")
    except OSError:
        with sftp.file(policy_path, "w") as f:
            f.write(json.dumps(VERSION_POLICY, ensure_ascii=False, indent=2))
        print("seeded version_policy.json")

    with sftp.file(f"{REMOTE_DIR}/{SERVICE}.service", "w") as f:
        f.write(UNIT)
    if SITE_PASSWORD:
        env_path = "/etc/wxqk/wxqk.env"
        try:
            with sftp.file(env_path, "r") as f:
                lines = f.read().decode("utf-8", "replace").splitlines()
        except OSError:
            lines = []
        lines = [line for line in lines if not line.startswith("WXQK_PASSWORD=")]
        lines.append(f"WXQK_PASSWORD={SITE_PASSWORD}")
        with sftp.file(env_path, "w") as f:
            f.write("\n".join(lines) + "\n")
        sftp.chmod(env_path, 0o600)
        print("updated protected wxqk password environment")
    sftp.close()

    run("python3 -m pip install -q 'cryptography>=41' 2>/dev/null || pip3 install -q 'cryptography>=41'")
    run(f"cd {REMOTE_DIR} && python3 -c \"import server, chat_media, client_gate, devices; print('imports ok')\"")
    run("install -d -m 700 /etc/wxqk; if [ ! -s /etc/wxqk/wxqk.env ]; then "
        "systemctl show wxqk.service -p Environment --value | tr ' ' '\\n' | "
        "sed -n '/^WXQK_PASSWORD=/p;/^FACAI888_PASSWORD=/p;/^WXQK_UPLOAD_TOKEN=/p;/^FACAI888_UPLOAD_TOKEN=/p' > /tmp/wxqk-env; "
        "install -m 600 /tmp/wxqk-env /etc/wxqk/wxqk.env; rm -f /tmp/wxqk-env; fi")
    run(f"cp {REMOTE_DIR}/{SERVICE}.service /etc/systemd/system/{SERVICE}.service")
    run("systemctl daemon-reload")
    run(f"systemctl enable --now {SERVICE}.service")
    run(f"systemctl restart {SERVICE}.service")
    time.sleep(1)
    run(f"systemctl --no-pager --full status {SERVICE}.service | head -25")

    nginx_script = (
        "from pathlib import Path\n"
        "p = Path('/etc/nginx/snippets/xiangyuzhubao-business.conf')\n"
        "text = p.read_text(encoding='utf-8')\n"
        "start = '# wxqk managed block'\n"
        "end = '# end wxqk managed block'\n"
        "a = text.find(start)\n"
        "if a >= 0:\n"
        "    b = text.find(end, a)\n"
        "    if b < 0: raise RuntimeError('incomplete wxqk nginx block')\n"
        "    text = text[:a] + text[b + len(end):].lstrip('\\r\\n')\n"
        f"block = {NGINX_BLOCK!r}\n"
        "needle = 'client_max_body_size 200m;\\n'\n"
        "text = text.replace(needle, needle + block, 1) if needle in text else block + text\n"
        "p.write_text(text, encoding='utf-8')\n"
        "print('nginx wxqk block upserted')\n"
    )
    sftp = client.open_sftp()
    with sftp.file(f"{REMOTE_DIR}/_upsert_nginx_wxqk.py", "w") as f:
        f.write(nginx_script)
    sftp.close()
    run(f"python3 {REMOTE_DIR}/_upsert_nginx_wxqk.py")
    run("nginx -t && systemctl reload nginx")
    run(f"curl -fsS http://127.0.0.1:{PORT}/ >/dev/null && echo local_ok")
    run("curl -sk -o /dev/null -w '%{http_code}\\n' https://127.0.0.1:8443/wxqk/ || true")
    client.close()
    print(f"wxqk deploy complete → https://{HOST}:8443/wxqk/")


if __name__ == "__main__":
    main()
