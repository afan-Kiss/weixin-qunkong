#!/usr/bin/env python3
"""Persist reuse_key=True for the LE IP certificate lineage (official reconfigure).

Also writes expected leaf SPKI for wxqk-ip-cert-check drift detection.
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

    print("=== BEFORE SPKI ===")
    before = run(
        c,
        f"openssl x509 -in /etc/letsencrypt/live/{ip}/cert.pem -pubkey -noout "
        "| openssl pkey -pubin -outform DER "
        "| openssl dgst -sha256 -binary "
        "| openssl base64",
    ).strip()
    print("spki_b64=", before)

    # Official path: reconfigure persists reuse_key and validates via staging dry-run
    run(
        c,
        f"certbot reconfigure --cert-name {ip} --reuse-key --non-interactive",
        timeout=300,
    )

    run(c, f"grep -nE 'reuse_key|reuse-key|key_type|preferred_profile' /etc/letsencrypt/renewal/{ip}.conf")
    run(c, f"cat /etc/letsencrypt/renewal/{ip}.conf")

    # Persist expected SPKI for monitor (do not overwrite if already set and matches)
    run(
        c,
        f"""python3 - <<'PY'
from pathlib import Path
import subprocess
ip = {ip!r}
path = Path({EXPECTED_SPKI_PATH!r})
path.parent.mkdir(parents=True, exist_ok=True)
out = subprocess.check_output(
    "openssl x509 -in /etc/letsencrypt/live/%s/cert.pem -pubkey -noout "
    "| openssl pkey -pubin -outform DER "
    "| openssl dgst -sha256 -binary "
    "| openssl base64" % ip,
    shell=True,
    text=True,
).strip()
pin = "sha256/" + out
old = path.read_text().strip() if path.exists() else ""
if old and old != pin and old != out:
    print("WARN: expected SPKI file already differs from current leaf; keeping existing:", old)
    print("current:", pin)
else:
    path.write_text(pin + "\\n")
    path.chmod(0o644)
    print("wrote", path, pin)
PY""",
    )

    print("=== dry-run renew (staging) ===")
    run(c, f"certbot renew --cert-name {ip} --dry-run", timeout=300)

    print("=== AFTER SPKI (live leaf; dry-run must not change it) ===")
    after = run(
        c,
        f"openssl x509 -in /etc/letsencrypt/live/{ip}/cert.pem -pubkey -noout "
        "| openssl pkey -pubin -outform DER "
        "| openssl dgst -sha256 -binary "
        "| openssl base64",
    ).strip()
    if after != before:
        raise SystemExit(f"CRITICAL: live SPKI changed during dry-run/reconfigure: {before} -> {after}")
    print("spki_unchanged", after)

    # Confirm renew paths inherit reuse_key from conf (no CLI flag needed)
    run(
        c,
        f"python3 - <<'PY'\n"
        f"from pathlib import Path\n"
        f"t=Path('/etc/letsencrypt/renewal/{ip}.conf').read_text()\n"
        f"assert 'reuse_key = True' in t or 'reuse_key=True' in t, t\n"
        f"print('reuse_key_persisted_ok')\n"
        f"PY",
    )
    c.close()
    print("REUSE_KEY_OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
