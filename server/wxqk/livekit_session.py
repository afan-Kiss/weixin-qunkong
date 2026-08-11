# -*- coding: utf-8 -*-
"""LiveKit room/token helpers for desktop media plane.

JPEG/WS capture stays on wxqk agent WS. LiveKit only carries the realtime video
(and optional data control) between agent publisher and admin/portal viewers.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import time
from typing import Any


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def livekit_enabled() -> bool:
    return bool(_api_key() and _api_secret() and _public_url())


def _api_key() -> str:
    return str(
        os.environ.get("WXQK_LIVEKIT_API_KEY")
        or os.environ.get("LIVEKIT_API_KEY")
        or ""
    ).strip()


def _api_secret() -> str:
    return str(
        os.environ.get("WXQK_LIVEKIT_API_SECRET")
        or os.environ.get("LIVEKIT_API_SECRET")
        or ""
    ).strip()


def _public_url() -> str:
    """URL agents/Electron use (ws/wss to LiveKit signaling)."""
    return str(
        os.environ.get("WXQK_LIVEKIT_URL")
        or os.environ.get("LIVEKIT_URL")
        or ""
    ).strip().rstrip("/")


def _browser_url() -> str:
    """URL browsers on the wall use; may be TLS-proxied domain."""
    return str(
        os.environ.get("WXQK_LIVEKIT_BROWSER_URL")
        or os.environ.get("LIVEKIT_BROWSER_URL")
        or _public_url()
    ).strip().rstrip("/")


def room_name_for_device(device_id: str) -> str:
    cid = "".join(ch for ch in str(device_id or "") if ch.isalnum())[:48]
    if not cid:
        cid = "unknown"
    return f"desk_{cid}"


def mint_token(
    *,
    identity: str,
    room: str,
    name: str = "",
    can_publish: bool = False,
    can_subscribe: bool = True,
    can_publish_data: bool = True,
    ttl_sec: int = 3600,
) -> str:
    """HS256 LiveKit access token (no livekit-api dependency)."""
    key = _api_key()
    secret = _api_secret()
    if not key or not secret:
        raise RuntimeError("livekit_keys_missing")
    now = int(time.time())
    header = {"alg": "HS256", "typ": "JWT"}
    video: dict[str, Any] = {
        "roomJoin": True,
        "room": room,
        "canSubscribe": bool(can_subscribe),
        "canPublish": bool(can_publish),
        "canPublishData": bool(can_publish_data),
    }
    if can_publish:
        video["canUpdateOwnMetadata"] = True
    body: dict[str, Any] = {
        "iss": key,
        "sub": str(identity or "user")[:128],
        "nbf": now - 5,
        "exp": now + max(60, int(ttl_sec)),
        "video": video,
    }
    if name:
        body["name"] = str(name)[:128]
    h = _b64url(json.dumps(header, separators=(",", ":"), ensure_ascii=False).encode("utf-8"))
    p = _b64url(json.dumps(body, separators=(",", ":"), ensure_ascii=False).encode("utf-8"))
    sig = hmac.new(secret.encode("utf-8"), f"{h}.{p}".encode("ascii"), hashlib.sha256).digest()
    return f"{h}.{p}.{_b64url(sig)}"


def issue_pair(device_id: str, *, viewer_identity: str = "", control: bool = False) -> dict[str, Any]:
    """Return LiveKit connect info for agent publisher + one viewer."""
    if not livekit_enabled():
        return {"ok": False, "code": "LIVEKIT_DISABLED", "message": "LiveKit not configured"}
    room = room_name_for_device(device_id)
    pub_id = f"agent_{''.join(ch for ch in device_id if ch.isalnum())[:40] or 'x'}"
    sub_id = str(viewer_identity or f"view_{int(time.time())}_{os.getpid()}")[:80]
    agent_url = _public_url()
    browser_url = _browser_url() or agent_url
    try:
        agent_token = mint_token(
            identity=pub_id,
            room=room,
            name="agent",
            can_publish=True,
            can_subscribe=False,
            can_publish_data=True,
            ttl_sec=3600,
        )
        viewer_token = mint_token(
            identity=sub_id,
            room=room,
            name="viewer",
            can_publish=False,
            can_subscribe=True,
            can_publish_data=bool(control),
            ttl_sec=3600,
        )
    except Exception as e:
        return {"ok": False, "message": str(e)}
    return {
        "ok": True,
        "transport": "livekit",
        "roomName": room,
        "livekitUrl": agent_url,
        "livekitBrowserUrl": browser_url,
        "agentToken": agent_token,
        "viewerToken": viewer_token,
        "agentIdentity": pub_id,
        "viewerIdentity": sub_id,
    }
