#!/usr/bin/env python3
"""Deploy facai888 to 47.108.21.50 and wire nginx /发财888 only."""
from __future__ import annotations

import json
import os
import time
from pathlib import Path

import paramiko

HOST = os.environ.get("WXQK_SSH_HOST", "47.108.21.50")
USER = os.environ.get("WXQK_SSH_USER", "root")
PASSWORD = os.environ.get("WXQK_SSH_PASSWORD") or None
REMOTE_DIR = "/opt/facai888"
LOCAL_SERVER = Path(__file__).with_name("server.py")
LOCAL_ADMIN_UI = Path(__file__).with_name("admin_ui.py")
LOCAL_ROAD = Path(__file__).with_name("road_archive.py")
LOCAL_SIM = Path(__file__).with_name("sim_bets.py")
LOCAL_WS = Path(__file__).with_name("wsutil.py")
LOCAL_TEXT_ROTATE = Path(__file__).with_name("text_rotate.py")
EXTRA_PY = [
    "analytics_versions.py",
    "analytics_db.py",
    "analytics_stats.py",
    "big_road_engine.py",
    "road_quality.py",
    "formula_events.py",
    "strict_replay.py",
    "audit_analytics.py",
    "security_db.py",
    "software_accounts.py",
    "security_audit.py",
    "command_queue.py",
    "rate_limit.py",
    # P0 client gate (heartbeat/online requires these)
    "client_gate.py",
    "device_auth.py",
    "devices.py",
    "version_policy.py",
    "update_manifest.py",
    # Release packages use this module for resumable parallel uploads.  Keep it
    # in the deployment list with admin_ui.py/server.py or the server falls
    # back to the previous tiny-part behavior.
    "chunk_upload.py",
    "meshcentral_client.py",
    "mesh_api.py",
    "current_table_store.py",
    "predictor_ws.py",
]

# Allow local/dev clients to appear online until real release BuildIDs are published.
VERSION_POLICY = {
    "minimumVersion": "0.0.0",
    "minimumBuildId": "",
    "minimumReleaseSequence": 0,
    "latestReleaseSequence": 0,
    "allowedBuildIds": ["dev"],
    "revokedBuildIds": [],
    "protocolVersion": "facai888-v1",
    "securityProtocolVersion": "security-v1",
    "desktopProtocolVersion": "desktop-webrtc-v1",
    "updaterProtocolVersion": "updater-v1",
    "latestVersion": "0.0.0",
    "latestBuildId": "dev",
    "releaseChannel": "stable",
    "legacyUploadTokenRetired": True,
    "oldClientsAllowed": False,
    "jpegDesktopUploadRetired": True,
    "failClosed": True,
}

# Retired brand path: hard 410 so it never falls through to the portal SPA.
NGINX_SIREN_GONE_BLOCK = """    location = /siren {
        return 410;
    }
    location ^~ /siren/ {
        return 410;
    }
"""

# Longer ^~ prefix beats ^~ /发财888/; also cover percent-encoded path.
# proxy_pass without URI keeps full path; server strips /发财888 prefix.
NGINX_FACAI_UPLOAD_BLOCK = """    location ^~ /发财888/api/admin/release/upload {
        proxy_pass http://127.0.0.1:4810;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_connect_timeout 60s;
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
        client_body_timeout 600s;
        client_max_body_size 250m;
        proxy_request_buffering off;
        proxy_buffering off;
        add_header Cache-Control "no-store";
    }
    location ^~ /%E5%8F%91%E8%B4%A2888/api/admin/release/upload {
        proxy_pass http://127.0.0.1:4810;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_connect_timeout 60s;
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
        client_body_timeout 600s;
        client_max_body_size 250m;
        proxy_request_buffering off;
        proxy_buffering off;
        add_header Cache-Control "no-store";
    }
"""

NGINX_FACAI_BLOCK = """    location = /发财888 {
        return 301 /发财888/;
    }
    location ^~ /发财888/ {
        proxy_pass http://127.0.0.1:4810/;
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
    }
"""

UNIT = """[Unit]
Description=发财888 remote board
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/facai888
Environment=FACAI888_PORT=4810
Environment=FACAI888_BIND=127.0.0.1
EnvironmentFile=-/etc/facai888/facai888.env
Environment=FACAI888_DATA=/opt/facai888/data
Environment=FACAI888_GIT_COMMIT=__GIT_COMMIT__
Environment=FACAI888_AUTO_ACTIVATE_DEVICES=1
Environment=FACAI888_PUBLISH_KEY_B64=TIwR8GPTQsAO49IXWjfXok0xHouoHGFbkTsi5B4Pf9A=
ExecStart=/usr/bin/python3 /opt/facai888/server.py
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
"""


def main() -> None:
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(HOST, username=USER, password=PASSWORD, timeout=20, allow_agent=PASSWORD is None, look_for_keys=PASSWORD is None)

    def run(cmd: str) -> str:
        _, stdout, stderr = c.exec_command(cmd, timeout=60)
        out = stdout.read().decode("utf-8", "replace")
        err = stderr.read().decode("utf-8", "replace")
        print("$", cmd)
        if out.strip():
            print(out[:2000])
        if err.strip():
            print("ERR", err[:1000])
        return out

    run(
        f"mkdir -p {REMOTE_DIR}/data/logs {REMOTE_DIR}/data/clients {REMOTE_DIR}/data/shots "
        f"{REMOTE_DIR}/data/commands {REMOTE_DIR}/data/formula {REMOTE_DIR}/data/roads {REMOTE_DIR}/data/sim-bets"
    )
    sftp = c.open_sftp()
    sftp.put(str(LOCAL_SERVER), f"{REMOTE_DIR}/server.py")
    if LOCAL_ADMIN_UI.exists():
        sftp.put(str(LOCAL_ADMIN_UI), f"{REMOTE_DIR}/admin_ui.py")
    if LOCAL_ROAD.exists():
        sftp.put(str(LOCAL_ROAD), f"{REMOTE_DIR}/road_archive.py")
    if LOCAL_SIM.exists():
        sftp.put(str(LOCAL_SIM), f"{REMOTE_DIR}/sim_bets.py")
    if LOCAL_WS.exists():
        sftp.put(str(LOCAL_WS), f"{REMOTE_DIR}/wsutil.py")
    if LOCAL_TEXT_ROTATE.exists():
        sftp.put(str(LOCAL_TEXT_ROTATE), f"{REMOTE_DIR}/text_rotate.py")
    for name in EXTRA_PY:
        local = Path(__file__).with_name(name)
        if local.exists():
            sftp.put(str(local), f"{REMOTE_DIR}/{name}")
            print("uploaded", name)
        else:
            print("MISSING local file:", name)

    # Seed version policy only on first install — never wipe published allow-list.
    policy_remote = f"{REMOTE_DIR}/data/version_policy.json"
    try:
        sftp.stat(policy_remote)
        print("keep existing version_policy.json")
    except OSError:
        with sftp.file(policy_remote, "w") as f:
            f.write(json.dumps(VERSION_POLICY, ensure_ascii=False, indent=2))
        print("seeded version_policy.json allowedBuildIds=", VERSION_POLICY["allowedBuildIds"])

    import subprocess

    try:
        git_commit = subprocess.check_output(
            ["git", "rev-parse", "HEAD"],
            cwd=str(Path(__file__).resolve().parents[2]),
            text=True,
        ).strip()
    except Exception:
        git_commit = "unknown"
    unit_text = UNIT.replace("__GIT_COMMIT__", git_commit)
    print("deploy gitCommit=", git_commit)

    with sftp.file(f"{REMOTE_DIR}/facai888.service", "w") as f:
        f.write(unit_text)
    sftp.close()

    run("python3 -m pip install -q 'cryptography>=41' 2>/dev/null || pip3 install -q 'cryptography>=41'")
    run(f"cd {REMOTE_DIR} && python3 -c \"import client_gate, devices, device_auth, version_policy; print('imports ok')\"")

    run(f"cp {REMOTE_DIR}/facai888.service /etc/systemd/system/facai888.service")
    run("systemctl daemon-reload")
    # Legacy betclient-siren unit (same :4810) — stop, disable, remove unit file.
    run("systemctl stop betclient-siren.service 2>/dev/null || true")
    run("systemctl disable betclient-siren.service 2>/dev/null || true")
    run("rm -f /etc/systemd/system/betclient-siren.service")
    run("systemctl daemon-reload")
    run("fuser -k 4810/tcp 2>/dev/null || true")
    time.sleep(1)
    run("systemctl reset-failed facai888.service 2>/dev/null || true")
    run("systemctl enable --now facai888.service")
    run("systemctl restart facai888.service")
    time.sleep(1)
    run("systemctl --no-pager status facai888.service | head -20")

    remote_py = (
        "from pathlib import Path\n"
        "p = Path('/etc/nginx/snippets/xiangyuzhubao-business.conf')\n"
        "lines = p.read_text(encoding='utf-8').splitlines(keepends=True)\n"
        f"siren_gone = {NGINX_SIREN_GONE_BLOCK!r}\n"
        f"upload = {NGINX_FACAI_UPLOAD_BLOCK!r}\n"
        f"facai = {NGINX_FACAI_BLOCK!r}\n"
        "DROP = ("
        "'location = /siren', 'location ^~ /siren/', "
        "'location ^~ /发财888/api/admin/release/upload', "
        "'location = /发财888/api/admin/release/upload', "
        "'location ^~ /%E5%8F%91%E8%B4%A2888/api/admin/release/upload', "
        "'location = /%E5%8F%91%E8%B4%A2888/api/admin/release/upload', "
        "'location = /发财888', 'location ^~ /发财888/'"
        ")\n"
        "out = []\n"
        "i = 0\n"
        "while i < len(lines):\n"
        "    raw = lines[i]\n"
        "    s = raw.strip()\n"
        "    if s.startswith('#') and (('siren' in s.lower() and ('看板' in s or '远程' in s)) or s.startswith('# 发财888')):\n"
        "        i += 1\n"
        "        continue\n"
        "    if any(s.startswith(pref) for pref in DROP):\n"
        "        depth = 0\n"
        "        started = False\n"
        "        while i < len(lines):\n"
        "            l2 = lines[i]\n"
        "            if '{' in l2:\n"
        "                started = True\n"
        "            depth += l2.count('{') - l2.count('}')\n"
        "            i += 1\n"
        "            if started and depth <= 0:\n"
        "                break\n"
        "        continue\n"
        "    out.append(raw)\n"
        "    i += 1\n"
        "text = ''.join(out)\n"
        "needle = 'client_max_body_size 200m;\\n'\n"
        "block = siren_gone + '\\n' + upload + '\\n' + facai + '\\n'\n"
        "if needle in text:\n"
        "    text = text.replace(needle, needle + block, 1)\n"
        "else:\n"
        "    text = block + text\n"
        "assert text.count('location = /siren') == 1\n"
        "assert text.count('location ^~ /siren/') == 1\n"
        "siren_chunk = text[text.find('location = /siren'):text.find('location ^~ /发财888/api/admin/release/upload')]\n"
        "assert 'proxy_pass' not in siren_chunk\n"
        "assert siren_chunk.count('return 410') >= 2\n"
        "assert text.count('location ^~ /发财888/api/admin/release/upload') == 1\n"
        "assert text.count('location ^~ /%E5%8F%91%E8%B4%A2888/api/admin/release/upload') == 1\n"
        "assert text.count('location = /发财888 {') == 1\n"
        # Exact general prefix (avoid counting the longer upload location as a hit).
        "assert sum(1 for ln in text.splitlines() if ln.strip().startswith('location ^~ /发财888/ {') or ln.strip()=='location ^~ /发财888/') == 1\n"
        "p.write_text(text, encoding='utf-8')\n"
        "print('nginx facai888 OK; /siren -> 410')\n"
    )
    sftp = c.open_sftp()
    with sftp.file(f"{REMOTE_DIR}/_upsert_nginx.py", "w") as f:
        f.write(remote_py)
    sftp.close()
    run(f"python3 {REMOTE_DIR}/_upsert_nginx.py")
    run("nginx -t && systemctl reload nginx")

    run("curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:4810/")
    print()
    run("curl -sS -o /dev/null -w '%{http_code}' --path-as-is -H 'Host: xiangyuzhubao.xyz' http://127.0.0.1/%E5%8F%91%E8%B4%A2888/")
    print()
    c.close()
    print("deploy done")


if __name__ == "__main__":
    main()
