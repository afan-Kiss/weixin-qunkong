#!/usr/bin/env python3
"""Push updated LE IP cert check + deploy-hook scripts to the server."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _finish_ip_tls import (  # noqa: E402
    DEPLOY_HOOK,
    FAILED_HOOK,
    PUBLIC_IP,
    HOST,
    check_script,
    connect,
    run,
)


def main() -> int:
    if not HOST:
        raise SystemExit("WXQK_SSH_HOST required")
    ip = PUBLIC_IP or HOST
    c = connect()
    sftp = c.open_sftp()
    try:
        run(c, "mkdir -p /etc/letsencrypt/renewal-hooks/deploy /etc/letsencrypt/renewal-hooks/failed /var/log/letsencrypt /etc/wxqk")
        with sftp.file("/etc/letsencrypt/renewal-hooks/deploy/wxqk-reload-nginx.sh", "w") as f:
            f.write(DEPLOY_HOOK)
        with sftp.file("/etc/letsencrypt/renewal-hooks/failed/wxqk-log-failure.sh", "w") as f:
            f.write(FAILED_HOOK)
        with sftp.file("/usr/local/sbin/wxqk-ip-cert-check", "w") as f:
            f.write(check_script(ip))
    finally:
        sftp.close()
    run(
        c,
        "chmod 755 /etc/letsencrypt/renewal-hooks/deploy/wxqk-reload-nginx.sh "
        "/etc/letsencrypt/renewal-hooks/failed/wxqk-log-failure.sh /usr/local/sbin/wxqk-ip-cert-check",
    )
    run(c, "/usr/local/sbin/wxqk-ip-cert-check; tail -n 40 /var/log/letsencrypt/wxqk-ip-cert-check.log")
    run(c, "systemctl is-enabled snap.certbot.renew.timer wxqk-ip-cert-check.timer")
    run(c, f"grep -n reuse_key /etc/letsencrypt/renewal/{ip}.conf")
    run(c, "cat /etc/wxqk/le-ip-expected-spki.txt")
    c.close()
    print("HOOKS_UPDATED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
