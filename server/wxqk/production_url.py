# -*- coding: utf-8 -*-
"""Production public base URL validation (fail-closed)."""
from __future__ import annotations

from urllib.parse import urlparse


_PLACEHOLDER_HOST_MARKERS = (
    "example.invalid",
    "example.com",
    "localhost",
    "127.0.0.1",
    "::1",
)


def is_placeholder_public_base_url(url: str) -> bool:
    raw = str(url or "").strip()
    if not raw:
        return True
    try:
        u = urlparse(raw)
    except Exception:
        return True
    host = str(u.hostname or "").strip().lower()
    if not host:
        return True
    if any(m in host for m in _PLACEHOLDER_HOST_MARKERS):
        return True
    if u.scheme != "https":
        return True
    return False


def assert_production_public_base_url(url: str, *, production: bool = True) -> None:
    if not production:
        return
    if is_placeholder_public_base_url(url):
        raise ValueError(
            "PRODUCTION_URL_GATE: WXQK_PUBLIC_BASE_URL / FACAI888_PUBLIC_BASE_URL "
            "must be a real https host (placeholder/localhost rejected)"
        )
