# -*- coding: utf-8 -*-
"""WebRTC desktop session + ICE/TURN credential helpers (signaling only)."""
from __future__ import annotations

import base64
import hashlib
import hmac
import os
import secrets
import time
from typing import Any

_sessions: dict[str, dict[str, Any]] = {}

# 无自建 TURN 时仍提供公网 STUN，保证多数网络可打洞（失败再考虑配 TURN）
_PUBLIC_STUN = [
    {"urls": ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"]},
]


def _turn_secret() -> str:
    return str(
        os.environ.get("FACAI888_TURN_SECRET")
        or os.environ.get("WXQK_TURN_SECRET")
        or os.environ.get("SIREN_TURN_SECRET")
        or ""
    ).strip()


def _turn_host() -> str:
    """Public host/IP used in iceServers URLs (must match coturn external-ip / DNS)."""
    explicit = str(
        os.environ.get("FACAI888_TURN_HOST")
        or os.environ.get("WXQK_TURN_HOST")
        or ""
    ).strip()
    if explicit:
        return explicit
    # Derive from public base URL host when possible (new IP deploy).
    base = str(
        os.environ.get("FACAI888_PUBLIC_BASE_URL")
        or os.environ.get("WXQK_PUBLIC_BASE_URL")
        or ""
    ).strip()
    if "://" in base:
        try:
            from urllib.parse import urlparse

            host = (urlparse(base).hostname or "").strip()
            if host:
                return host
        except Exception:
            pass
    return "120.27.219.138"


def ice_config() -> dict[str, Any]:
    """Return ICE servers. Always includes public STUN; TURN only when secret configured.

    JPEG/WS desktop transport is independent — this only affects WebRTC viewers/agents.
    """
    servers: list[dict[str, Any]] = list(_PUBLIC_STUN)
    secret = _turn_secret()
    host = _turn_host()
    if secret and host:
        expiry = int(time.time()) + 600
        user = f"{expiry}:wxqk"
        dig = hmac.new(secret.encode("utf-8"), user.encode("utf-8"), hashlib.sha1).digest()
        password = base64.b64encode(dig).decode("ascii")
        servers.append({"urls": [f"stun:{host}:3478"]})
        # 自签 turns:5349 会让浏览器/Electron 卡很久；只用 3478 UDP/TCP
        servers.append(
            {
                "urls": [
                    f"turn:{host}:3478?transport=udp",
                    f"turn:{host}:3478?transport=tcp",
                ],
                "username": user,
                "credential": password,
            }
        )
        return {
            "ok": True,
            "iceServers": servers,
            "iceTransportPolicy": "all",
            "bundlePolicy": "max-bundle",
            "turnConfigured": True,
        }
    return {
        "ok": True,
        "iceServers": servers,
        "iceTransportPolicy": "all",
        "bundlePolicy": "max-bundle",
        "turnConfigured": False,
        "code": "STUN_ONLY",
        "message": "TURN not configured; using public STUN only",
    }


def prune_sessions() -> int:
    """Drop expired WebRTC sessions (best-effort GC)."""
    now = time.time()
    dead = [sid for sid, s in list(_sessions.items()) if float((s or {}).get("expiresAt") or 0) < now]
    for sid in dead:
        _sessions.pop(sid, None)
    # 硬上限：极端情况下按过期时间踢最旧的
    if len(_sessions) > 2000:
        ordered = sorted(
            _sessions.items(),
            key=lambda kv: float((kv[1] or {}).get("expiresAt") or 0),
        )
        for sid, _ in ordered[: max(0, len(_sessions) - 1500)]:
            _sessions.pop(sid, None)
    return len(dead)


def _active_session_for_device(device_id: str) -> dict[str, Any] | None:
    """Reuse a still-valid LiveKit session for the same device (same room)."""
    now = time.time()
    best: dict[str, Any] | None = None
    best_exp = 0.0
    for s in _sessions.values():
        if not isinstance(s, dict):
            continue
        if str(s.get("deviceId") or "") != device_id:
            continue
        if str(s.get("transport") or "") != "livekit":
            continue
        exp = float(s.get("expiresAt") or 0)
        # 至少再活 5 分钟才复用，避免边界过期
        if exp < now + 300:
            continue
        if not (s.get("agentToken") and s.get("viewerToken") and s.get("livekitUrl")):
            continue
        if exp > best_exp:
            best = s
            best_exp = exp
    return best


def create_session(body: dict[str, Any]) -> dict[str, Any]:
    device_id = str(body.get("deviceId") or body.get("clientId") or "").strip()
    if not device_id:
        return {"ok": False, "message": "missing_deviceId"}
    prune_sessions()
    force_new = bool(body.get("forceNew") or body.get("forceRestart"))
    control_mouse = bool(body.get("controlMouse"))
    control_keyboard = bool(body.get("controlKeyboard"))
    # 屏幕墙轮询会反复建会话；同设备复用 sid/房间/agentToken，避免代理 DUPLICATE_IDENTITY 风暴
    if not force_new:
        reused = _active_session_for_device(device_id)
        if reused:
            ice = ice_config()
            ice_servers = ice.get("iceServers") or list(_PUBLIC_STUN)
            reused["iceServers"] = ice_servers
            reused["turnConfigured"] = bool(ice.get("turnConfigured"))
            # 权限以本次请求为准（墙默认无键鼠）
            perms = dict(reused.get("permissions") or {})
            perms["CONTROL_MOUSE"] = control_mouse
            perms["CONTROL_KEYBOARD"] = control_keyboard
            reused["permissions"] = perms
            if body.get("quality"):
                reused["quality"] = str(body.get("quality") or reused.get("quality") or "auto")
            now = time.time()
            # 续期 sid，避免整点强制换会话刷 watch
            reused["expiresAt"] = now + 3600
            # 只换观众 token；agentToken/room 保持，推流端无需重进
            # 距过期不足 10 分钟时顺带换 agentToken（由下次 force 软窗下发），防 JWT 过期重连风暴
            agent_issued = float(reused.get("agentTokenIssuedAt") or reused.get("issuedAt") or 0)
            refresh_agent = (now - agent_issued) > 3000  # ~50min into 60min TTL
            try:
                import livekit_session as lks

                if lks.livekit_enabled():
                    vid = str(body.get("viewerSessionId") or secrets.token_hex(8))
                    reused["viewerSessionId"] = vid
                    pair = lks.issue_pair(
                        device_id,
                        viewer_identity=vid,
                        control=bool(control_mouse or control_keyboard),
                    )
                    if pair.get("ok") and pair.get("viewerToken"):
                        reused["viewerToken"] = pair.get("viewerToken")
                        if refresh_agent and pair.get("agentToken"):
                            reused["agentToken"] = pair.get("agentToken")
                            reused["agentTokenIssuedAt"] = now
                            reused["agentTokenRotated"] = True
                        elif not reused.get("agentToken") and pair.get("agentToken"):
                            reused["agentToken"] = pair.get("agentToken")
                            reused["agentTokenIssuedAt"] = now
                        if pair.get("livekitBrowserUrl"):
                            reused["livekitBrowserUrl"] = pair.get("livekitBrowserUrl")
            except Exception:
                pass
            out = {
                "ok": True,
                **reused,
                "iceServers": ice_servers,
                "turnConfigured": bool(ice.get("turnConfigured")),
                "reused": True,
            }
            out.pop("agentToken", None)
            out.pop("agentTokenRotated", None)
            return out
    sid = secrets.token_hex(12)
    now = time.time()
    sess = {
        "desktopSessionId": sid,
        "deviceId": device_id,
        "viewerSessionId": str(body.get("viewerSessionId") or secrets.token_hex(8)),
        "issuedAt": now,
        "expiresAt": now + 3600,
        "agentTokenIssuedAt": now,
        "protocolVersion": "desktop-livekit-v1",
        "permissions": {
            "VIEW_DESKTOP": True,
            "CONTROL_MOUSE": control_mouse,
            "CONTROL_KEYBOARD": control_keyboard,
            "BROWSE_FILES": bool(body.get("browseFiles")),
            "DOWNLOAD_FILES": bool(body.get("downloadFiles")),
        },
        "quality": str(body.get("quality") or "auto"),
    }
    ice = ice_config()
    ice_servers = ice.get("iceServers") or list(_PUBLIC_STUN)
    # Persist ICE on session so later viewer `watch` can start agent with TURN creds
    # even when /session used deferStart (avoid offer-before-viewer race).
    sess["iceServers"] = ice_servers
    sess["turnConfigured"] = bool(ice.get("turnConfigured"))

    transport = "jpeg"
    livekit_payload: dict[str, Any] = {}
    try:
        import livekit_session as lks

        if lks.livekit_enabled():
            pair = lks.issue_pair(
                device_id,
                viewer_identity=str(sess["viewerSessionId"]),
                control=bool(control_mouse or control_keyboard),
            )
            if pair.get("ok"):
                transport = "livekit"
                livekit_payload = {
                    "transport": "livekit",
                    "roomName": pair.get("roomName"),
                    "livekitUrl": pair.get("livekitUrl"),
                    "livekitBrowserUrl": pair.get("livekitBrowserUrl") or pair.get("livekitUrl"),
                    "agentToken": pair.get("agentToken"),
                    "viewerToken": pair.get("viewerToken"),
                }
                sess.update(livekit_payload)
    except Exception:
        transport = "jpeg"

    sess["transport"] = transport
    _sessions[sid] = sess
    out = {
        "ok": True,
        **sess,
        "iceServers": ice_servers,
        "turnConfigured": bool(ice.get("turnConfigured")),
    }
    # Never send agentToken to browser clients in the same blob if avoidable —
    # still needed by watch→agent path via get_session on server only.
    # Viewers should use viewerToken; strip agentToken from HTTP response.
    out.pop("agentToken", None)
    return out


def stop_session(body: dict[str, Any]) -> dict[str, Any]:
    sid = str(body.get("desktopSessionId") or "").strip()
    if sid and sid in _sessions:
        del _sessions[sid]
    prune_sessions()
    return {"ok": True}


def get_session(sid: str) -> dict[str, Any] | None:
    s = _sessions.get(sid)
    if not s:
        return None
    if float(s.get("expiresAt") or 0) < time.time():
        _sessions.pop(sid, None)
        return None
    return s
