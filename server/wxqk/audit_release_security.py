# -*- coding: utf-8 -*-
"""Release security audit — fail on known insecure defaults."""
from __future__ import annotations

import ast
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
FAILS: list[str] = []


def fail(msg: str) -> None:
    FAILS.append(msg)


def check_version_policy() -> None:
    p = ROOT / "version_policy.py"
    t = p.read_text(encoding="utf-8")
    if "oldClientsAllowed\": True" in t or '"oldClientsAllowed": True' in t:
        fail("version_policy still allows oldClientsAllowed=True by default")
    if "legacyUploadTokenRetired\": False" in t or '"legacyUploadTokenRetired": False' in t:
        fail("legacyUploadTokenRetired must default True")
    if "jpegDesktopUploadRetired\": False" in t or '"jpegDesktopUploadRetired": False' in t:
        fail("jpegDesktopUploadRetired must default True")
    if "VERSION_POLICY_NOT_READY" not in t:
        fail("empty allowedBuildIds must yield VERSION_POLICY_NOT_READY")


def check_no_shared_token_required() -> None:
    t = (ROOT / "server.py").read_text(encoding="utf-8")
    if "if not SITE_PASSWORD or not UPLOAD_TOKEN" in t:
        fail("server still requires UPLOAD_TOKEN at startup")


def check_siren_410() -> None:
    t = (ROOT / "server.py").read_text(encoding="utf-8")
    if "LEGACY_PATH_REMOVED" not in t:
        fail("/siren 410 handler missing")


def main() -> int:
    check_version_policy()
    check_no_shared_token_required()
    check_siren_410()
    if FAILS:
        print("FAIL")
        for f in FAILS:
            print(" -", f)
        return 1
    print("OK audit_release_security")
    return 0


if __name__ == "__main__":
    sys.exit(main())
