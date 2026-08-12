#!/usr/bin/env python3
"""Switch wxqk :8443 nginx to the existing Let's Encrypt IP certificate.

Requires:
  WXQK_SSH_HOST
  WXQK_PUBLIC_IP (defaults to WXQK_SSH_HOST)
  WXQK_SSH_PASSWORD or SSH keys
  known_hosts via WXQK_SSH_KNOWN_HOSTS or ~/.ssh/known_hosts
  optional WXQK_SSH_HOST_FINGERPRINT

Does not change MeshCentral / 8444 / 4433. Backs up previous 8443 site config.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

# Reuse hardened connect from _finish_ip_tls
sys.path.insert(0, str(Path(__file__).resolve().parent))
from _finish_ip_tls import PUBLIC_IP, HOST, connect, run  # type: ignore


def main() -> int:
    if not HOST:
        raise SystemExit("WXQK_SSH_HOST required")
    ip = PUBLIC_IP or HOST
    c = connect()
    run(c, f"test -f /etc/letsencrypt/live/{ip}/fullchain.pem")
    run(c, f"test -f /etc/letsencrypt/live/{ip}/privkey.pem")
    run(
        c,
        "mkdir -p /etc/nginx/backup-8443 && "
        "cp -a /etc/nginx/sites-available/wxqk-https-8443.conf "
        f"/etc/nginx/backup-8443/wxqk-https-8443.conf.bak-$(date +%Y%m%d%H%M%S)",
    )
    # Patch only certificate paths; keep rest of site intact
    run(
        c,
        f"""python3 - <<'PY'
from pathlib import Path
p = Path('/etc/nginx/sites-available/wxqk-https-8443.conf')
text = p.read_text(encoding='utf-8')
old_crt = 'ssl_certificate     /etc/nginx/ssl/wxqk-ip.crt;'
old_key = 'ssl_certificate_key /etc/nginx/ssl/wxqk-ip.key;'
new_crt = 'ssl_certificate     /etc/letsencrypt/live/{ip}/fullchain.pem;'
new_key = 'ssl_certificate_key /etc/letsencrypt/live/{ip}/privkey.pem;'
if old_crt not in text and '/etc/letsencrypt/live/{ip}/fullchain.pem' in text:
    print('already_on_le')
else:
    if old_crt not in text or old_key not in text:
        raise SystemExit('unexpected 8443 ssl paths; abort')
    text = text.replace(old_crt, new_crt).replace(old_key, new_key)
    p.write_text(text, encoding='utf-8')
    print('patched_8443_to_le')
print(p.read_text(encoding='utf-8'))
PY""",
    )
    run(c, "nginx -t && systemctl reload nginx")
    run(c, f"curl -sI --max-time 15 https://{ip}:8443/wxqk/ | head -n 15")
    run(c, f"curl -sI --max-time 15 https://{ip}:8444/ | head -n 12")
    run(
        c,
        f"echo | openssl s_client -connect {ip}:8443 -servername {ip} 2>/dev/null | openssl x509 -noout -issuer -dates",
        check=False,
    )
    run(
        c,
        f"""python3 - <<'PY'
import hashlib, base64
from pathlib import Path
from cryptography import x509
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
pem = Path('/etc/letsencrypt/live/{ip}/cert.pem').read_bytes()
cert = x509.load_pem_x509_certificate(pem)
der = cert.public_key().public_bytes(Encoding.DER, PublicFormat.SubjectPublicKeyInfo)
print('spki', 'sha256/' + base64.b64encode(hashlib.sha256(der).digest()).decode())
PY""",
        check=False,
    )
    c.close()
    print("SWITCH_8443_LE_OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
