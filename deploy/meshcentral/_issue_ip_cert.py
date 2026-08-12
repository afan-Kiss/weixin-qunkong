#!/usr/bin/env python3
"""First-time Let's Encrypt IP certificate issuance with persistent reuse-key.

Env:
  WXQK_SSH_HOST (required)
  WXQK_PUBLIC_IP (default = SSH host)
  WXQK_SSH_USER / WXQK_SSH_PASSWORD / known_hosts / fingerprint (see _finish_ip_tls)

Always passes:
  --preferred-profile shortlived
  --ip-address <IP>
  --reuse-key
  --webroot --webroot-path /var/www/html

Writes /etc/wxqk/le-ip-expected-spki.txt from the issued leaf for pin monitoring.
Does not force production renewals; use certbot renew / timers afterwards.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _finish_ip_tls import PUBLIC_IP, HOST, connect, run  # noqa: E402

EXPECTED_SPKI_PATH = "/etc/wxqk/le-ip-expected-spki.txt"


def main() -> int:
    if not HOST:
        raise SystemExit("WXQK_SSH_HOST required")
    ip = PUBLIC_IP or HOST
    c = connect()

    # Ensure ACME webroot exists (caller should already patch nginx include)
    run(c, "mkdir -p /var/www/html/.well-known/acme-challenge && chmod -R a+rX /var/www/html/.well-known")

    run(
        c,
        "certbot certonly "
        "--preferred-profile shortlived "
        "--webroot --webroot-path /var/www/html "
        f"--ip-address {ip} "
        "--reuse-key "
        "--agree-tos --register-unsafely-without-email "
        "--non-interactive "
        f"--cert-name {ip} "
        "--keep-until-expiring",
        timeout=300,
    )

    run(c, f"grep -nE 'reuse_key|preferred_profile|authenticator|key_type' /etc/letsencrypt/renewal/{ip}.conf")
    # Persist expected SPKI
    run(
        c,
        f"""python3 - <<'PY'
from pathlib import Path
import subprocess
ip = {ip!r}
out = subprocess.check_output(
    "openssl x509 -in /etc/letsencrypt/live/%s/cert.pem -pubkey -noout "
    "| openssl pkey -pubin -outform DER "
    "| openssl dgst -sha256 -binary "
    "| openssl base64" % ip,
    shell=True,
    text=True,
).strip()
pin = "sha256/" + out
path = Path({EXPECTED_SPKI_PATH!r})
path.parent.mkdir(parents=True, exist_ok=True)
path.write_text(pin + "\\n")
path.chmod(0o644)
print("expected_spki", pin)
# Fail closed if reuse_key missing after first issue
text = Path(f"/etc/letsencrypt/renewal/{ip}.conf").read_text()
if "reuse_key = True" not in text and "reuse_key=True" not in text:
    raise SystemExit("reuse_key not persisted after certonly --reuse-key")
print("reuse_key_ok")
PY""",
    )
    c.close()
    print("ISSUE_IP_CERT_OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
