#!/usr/bin/env python3
import os
import paramiko

def main() -> None:
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(
        os.environ["WXQK_SSH_HOST"],
        username=os.environ.get("WXQK_SSH_USER", "root"),
        password=os.environ["WXQK_SSH_PASSWORD"],
        timeout=30,
        allow_agent=False,
        look_for_keys=False,
    )
    cmds = [
        "docker --version; docker compose version; systemctl is-active docker; systemctl is-enabled docker",
        "nginx -v 2>&1; systemctl is-active nginx; ls /etc/nginx/sites-enabled/ 2>/dev/null; ls /etc/nginx/conf.d/ 2>/dev/null",
        "systemctl is-active wxqk; systemctl status wxqk --no-pager -l | head -n 30",
        "ss -tulpn | egrep ':(80|443|8443|4812|9443|4433|8080|3000)\\b' || true",
        "ls -la /opt/wxqk | head -n 40; ls -la /opt/wxqk/meshcentral 2>/dev/null || echo no-meshcentral-yet",
        "test -f /etc/systemd/system/wxqk.service && cat /etc/systemd/system/wxqk.service || true",
        "ufw status || true",
    ]
    for cmd in cmds:
        print("====", cmd[:70])
        _stdin, stdout, stderr = c.exec_command(cmd, timeout=60)
        print(stdout.read().decode("utf-8", errors="replace")[:5000])
        err = stderr.read().decode("utf-8", errors="replace")[:1000]
        if err.strip():
            print("ERR", err[:800])
    c.close()


if __name__ == "__main__":
    main()
