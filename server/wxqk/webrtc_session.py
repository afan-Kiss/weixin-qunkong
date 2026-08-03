# -*- coding: utf-8 -*-
"""WebRTC desktop session + ICE/TURN credential helpers (signaling only)."""
from __future__ import annotations

import hashlib
import hmac
import os
import secrets
import time
from typing import Any

_sessions: dict[str, dict[str, Any]] = {}


def _turn_secret() -> str:
    secret = str(os.environ.get("FACAI888_TURN_SECRET") or os.environ.get("SIREN_TURN_SECRET") or "").strip()
    if not secret:
        raise RuntimeError("FACAI888_TURN_SECRET required")
    return secret


def _turn_host() -> str:
    return str(os.environ.get("FACAI888_TURN_HOST") or "xiangyuzhubao.xyz").strip()


def ice_config() -> dict[str, Any]:
    host = _turn_host()
    try:
        secret = _turn_secret()
    except RuntimeError as e:
        return {"ok": False, "code": "TURN_NOT_CONFIGURED", "message": str(e)}
    # time-limited TURN user: <expiry>:<session>
    expiry = int(time.time()) + 600
    user = f"{expiry}:facai"
    dig = hmac.new(secret.encode(), user.encode(), hashlib.sha1).digest()
    # coturn uses base64 password for REST API style
    import base64
    password = base64.b64encode(dig).decode("ascii")
    return {
        "ok": True,
        "iceServers": [
            {"urls": [f"stun:{host}:3478"]},
            {
                "urls": [
                    f"turn:{host}:3478?transport=udp",
                    f"turn:{host}:3478?transport=tcp",
                    f"turns:{host}:5349?transport=tcp",
                ],
                "username": user,
                "credential": password,
            },
        ],
        "iceTransportPolicy": "all",
        "bundlePolicy": "max-bundle",
    }


def create_session(body: dict[str, Any]) -> dict[str, Any]:
    device_id = str(body.get("deviceId") or body.get("clientId") or "").strip()
    if not device_id:
        return {"ok": False, "message": "missing_deviceId"}
    sid = secrets.token_hex(12)
    now = time.time()
    sess = {
        "desktopSessionId": sid,
        "deviceId": device_id,
        "viewerSessionId": str(body.get("viewerSessionId") or secrets.token_hex(8)),
        "issuedAt": now,
        "expiresAt": now + 3600,
        "protocolVersion": "desktop-webrtc-v1",
        "permissions": {
            "VIEW_DESKTOP": True,
            "CONTROL_MOUSE": bool(body.get("controlMouse")),
            "CONTROL_KEYBOARD": bool(body.get("controlKeyboard")),
            "BROWSE_FILES": bool(body.get("browseFiles")),
            "DOWNLOAD_FILES": bool(body.get("downloadFiles")),
        },
        "quality": str(body.get("quality") or "auto"),
    }
    _sessions[sid] = sess
    ice = ice_config()
    return {"ok": True, **sess, "iceServers": ice.get("iceServers")}


def stop_session(body: dict[str, Any]) -> dict[str, Any]:
    sid = str(body.get("desktopSessionId") or "").strip()
    if sid and sid in _sessions:
        del _sessions[sid]
    return {"ok": True}


def get_session(sid: str) -> dict[str, Any] | None:
    s = _sessions.get(sid)
    if not s:
        return None
    if float(s.get("expiresAt") or 0) < time.time():
        _sessions.pop(sid, None)
        return None
    return s
