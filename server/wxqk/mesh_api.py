"""
HTTP handlers for MeshCentral integration.

Auth: admin token OR software Bearer.
Software users may only operate clientIds they own (online meta.account match)
unless listed in WXQK_MESH_OPS_USERS.
Never crash wxqk if Mesh is disabled.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Callable, Optional

SendFn = Callable[[int, dict[str, Any]], None]
AuthResult = dict[str, Any]


def _disabled_payload() -> dict[str, Any]:
    return {"ok": False, "code": "MESH_DISABLED", "message": "MeshCentral 未启用"}


def _load_client():
    try:
        import meshcentral_client as mc
        return mc
    except Exception:
        return None


def _ops_usernames() -> set[str]:
    raw = str(os.environ.get("WXQK_MESH_OPS_USERS") or "").strip()
    if not raw:
        return set()
    return {x.strip().lower() for x in raw.split(",") if x.strip()}


def resolve_mesh_auth(
    headers: Any,
    data_dir: Path,
    *,
    check_admin_token: Callable[[str], bool],
) -> AuthResult:
    """Return {ok, role: admin|software, username, message}."""
    tok = str(getattr(headers, "get", lambda *_: "")("X-Admin-Token") or "")
    if not tok and hasattr(headers, "get"):
        tok = str(headers.get("X-Admin-Token") or "")
    if tok and check_admin_token(tok):
        return {"ok": True, "role": "admin", "username": "", "message": "admin"}

    auth = ""
    if hasattr(headers, "get"):
        auth = str(headers.get("Authorization") or "")
    bearer = auth[7:].strip() if auth.lower().startswith("bearer ") else ""
    if not bearer:
        return {"ok": False, "role": "", "username": "", "message": "需要管理员或软件登录"}
    try:
        import software_accounts as accounts
        account = accounts.session(data_dir, bearer)
    except Exception as exc:
        return {"ok": False, "role": "", "username": "", "message": str(exc)}
    if not account:
        return {"ok": False, "role": "", "username": "", "message": "登录已失效"}
    username = str(account.get("username") or "").strip()
    return {"ok": True, "role": "software", "username": username, "message": "software"}


def authorize_client_access(
    data_dir: Path,
    auth: AuthResult,
    client_id: str,
    *,
    get_online_meta: Optional[Callable[[str], dict]] = None,
) -> dict[str, Any]:
    """Enforce user A cannot control user B's devices."""
    if not auth.get("ok"):
        return {"ok": False, "code": "UNAUTHORIZED", "message": auth.get("message") or "未授权"}
    if auth.get("role") == "admin":
        return {"ok": True}
    username = str(auth.get("username") or "").strip()
    if not username:
        return {"ok": False, "code": "FORBIDDEN", "message": "缺少软件账号"}
    if username.lower() in _ops_usernames():
        return {"ok": True}
    cid = str(client_id or "").strip()
    if not cid:
        return {"ok": False, "code": "BAD_REQUEST", "message": "clientId 必填"}
    meta: dict = {}
    if get_online_meta:
        try:
            meta = get_online_meta(cid) or {}
        except Exception:
            meta = {}
    owner = str(meta.get("account") or "").strip()
    if owner and owner.lower() == username.lower():
        return {"ok": True}
    # Also allow bind ownership recorded on mapping
    try:
        import meshcentral_client as mc
        row = mc.get_mapping(data_dir, cid) or {}
        map_owner = str(row.get("owner_username") or row.get("account") or "").strip()
        if map_owner and map_owner.lower() == username.lower():
            return {"ok": True}
    except Exception:
        pass
    return {
        "ok": False,
        "code": "FORBIDDEN",
        "message": "无权操作该设备（用户隔离）",
    }


def handle_health(data_dir: Path, send: SendFn, *, deep: bool = False, admin: bool = False) -> bool:
    mc = _load_client()
    if mc is None:
        send(200, {
            **_disabled_payload(),
            "message": "meshcentral_client 未加载",
            "enabled": False,
            "meshReachable": False,
            "controlChannel": False,
            "loginKeyConfigured": False,
            "version": "1.2.4",
            "webRtcDisabled": True,
            "userMessage": "远程维护服务器未配置",
        })
        return True
    try:
        # Deep control.ashx probe is admin-only; never return secrets.
        payload = mc.health_check(deep=bool(deep and admin))
        # Strip any accidental secret-ish fields
        for bad in ("loginKey", "loginTokenKey", "password", "cookie", "token", "embedUrl"):
            payload.pop(bad, None)
        send(200, payload)
    except Exception as exc:
        send(200, {
            "ok": False,
            "code": "MESH_ERROR",
            "message": "MeshCentral 诊断失败",
            "enabled": False,
            "meshReachable": False,
            "controlChannel": False,
            "loginKeyConfigured": False,
            "version": "1.2.4",
            "webRtcDisabled": True,
            "userMessage": "远程维护服务器不可达",
            "detail": str(exc)[:120],
        })
    return True


def handle_status(data_dir: Path, client_id: str, send: SendFn) -> bool:
    mc = _load_client()
    if mc is None:
        send(200, {**_disabled_payload(), "clientId": client_id})
        return True
    cid = str(client_id or "").strip()
    if not cid:
        send(400, {"ok": False, "code": "BAD_REQUEST", "message": "clientId 必填"})
        return True
    try:
        send(200, mc.get_device_status(data_dir, cid))
    except Exception as exc:
        send(200, {"ok": False, "code": "MESH_ERROR", "message": str(exc), "clientId": cid})
    return True


def handle_session_desktop(
    data_dir: Path,
    body: dict[str, Any],
    send: SendFn,
    *,
    owner_username: str = "",
    get_online_meta: Optional[Callable[[str], dict]] = None,
) -> bool:
    mc = _load_client()
    if mc is None:
        send(200, _disabled_payload())
        return True
    cid = str((body or {}).get("clientId") or "").strip()
    if not cid:
        send(400, {"ok": False, "code": "BAD_REQUEST", "message": "clientId 必填"})
        return True
    hostname = str((body or {}).get("hostname") or (body or {}).get("host") or "").strip()
    if not hostname and get_online_meta:
        try:
            meta = get_online_meta(cid) or {}
            hostname = str(meta.get("hostname") or meta.get("host") or "").strip()
        except Exception:
            hostname = ""
    try:
        send(
            200,
            mc.get_remote_session(
                data_dir,
                cid,
                hostname=hostname,
                owner_username=owner_username,
            ),
        )
    except Exception as exc:
        send(200, {"ok": False, "code": "MESH_ERROR", "message": str(exc)})
    return True


def handle_session_files(
    data_dir: Path,
    body: dict[str, Any],
    send: SendFn,
    *,
    owner_username: str = "",
    get_online_meta: Optional[Callable[[str], dict]] = None,
) -> bool:
    mc = _load_client()
    if mc is None:
        send(200, _disabled_payload())
        return True
    cid = str((body or {}).get("clientId") or "").strip()
    if not cid:
        send(400, {"ok": False, "code": "BAD_REQUEST", "message": "clientId 必填"})
        return True
    hostname = str((body or {}).get("hostname") or (body or {}).get("host") or "").strip()
    if not hostname and get_online_meta:
        try:
            meta = get_online_meta(cid) or {}
            hostname = str(meta.get("hostname") or meta.get("host") or "").strip()
        except Exception:
            hostname = ""
    try:
        send(
            200,
            mc.get_files_session(
                data_dir,
                cid,
                hostname=hostname,
                owner_username=owner_username,
            ),
        )
    except Exception as exc:
        send(200, {"ok": False, "code": "MESH_ERROR", "message": str(exc)})
    return True


def handle_bind(data_dir: Path, body: dict[str, Any], send: SendFn, *, owner_username: str = "") -> bool:
    mc = _load_client()
    if mc is None:
        send(200, _disabled_payload())
        return True
    row = body if isinstance(body, dict) else {}
    cid = str(row.get("clientId") or "").strip()
    node_id = str(row.get("meshNodeId") or row.get("mesh_node_id") or "").strip()
    group_id = str(row.get("meshGroupId") or row.get("mesh_group_id") or "").strip()
    if not cid or not node_id:
        send(400, {"ok": False, "code": "BAD_REQUEST", "message": "clientId 与 meshNodeId 必填"})
        return True
    try:
        if not mc.is_enabled():
            send(200, _disabled_payload())
            return True
        extra = {}
        if owner_username:
            extra["owner_username"] = owner_username
        mapping = mc.sync_device_mapping(
            data_dir,
            client_id=cid,
            mesh_node_id=node_id,
            mesh_group_id=group_id,
            mesh_agent_status=str(row.get("meshAgentStatus") or "bound"),
            **extra,
        )
        send(200, {"ok": True, "code": "OK", "mapping": mapping, "message": "已绑定"})
    except Exception as exc:
        send(200, {"ok": False, "code": "MESH_ERROR", "message": str(exc)})
    return True


def handle_auto_bind(
    data_dir: Path,
    body: dict[str, Any],
    send: SendFn,
    *,
    owner_username: str = "",
    get_online_meta: Optional[Callable[[str], dict]] = None,
) -> bool:
    mc = _load_client()
    if mc is None:
        send(200, _disabled_payload())
        return True
    cid = str((body or {}).get("clientId") or "").strip()
    if not cid:
        send(400, {"ok": False, "code": "BAD_REQUEST", "message": "clientId 必填"})
        return True
    hostname = str((body or {}).get("hostname") or (body or {}).get("host") or "").strip()
    if not hostname and get_online_meta:
        try:
            meta = get_online_meta(cid) or {}
            hostname = str(meta.get("hostname") or meta.get("host") or "").strip()
        except Exception:
            hostname = ""
    agent_name = str((body or {}).get("agentName") or (body or {}).get("agent_name") or "").strip()
    allow_hostname = body.get("allowHostnameFallback")
    if allow_hostname is None:
        allow_hostname = body.get("allow_hostname_fallback")
    allow_hostname_fallback = True if allow_hostname is None else bool(allow_hostname)
    try:
        if not mc.is_enabled():
            send(200, _disabled_payload())
            return True
        result = mc.auto_bind_client(
            data_dir,
            cid,
            owner_username=owner_username,
            hostname=hostname,
            allow_hostname_fallback=allow_hostname_fallback,
            agent_name=agent_name,
        )
        send(200, result)
    except Exception as exc:
        send(200, {"ok": False, "code": "MESH_ERROR", "message": str(exc)})
    return True


def try_handle_get(
    path: str,
    qs: dict,
    data_dir: Path,
    require_admin: Callable[[], bool],
    send: SendFn,
    *,
    headers: Any = None,
    check_admin_token: Optional[Callable[[str], bool]] = None,
    get_online_meta: Optional[Callable[[str], dict]] = None,
) -> bool:
    """Return True if the request was handled (including auth failure)."""
    if path not in ("/api/mesh/health", "/api/mesh/status"):
        return False

    auth: AuthResult
    if headers is not None and check_admin_token is not None:
        auth = resolve_mesh_auth(headers, data_dir, check_admin_token=check_admin_token)
        if not auth.get("ok"):
            # fallback to legacy admin-only gate for callers that only pass require_admin
            if not require_admin():
                return True
            auth = {"ok": True, "role": "admin", "username": "", "message": "admin"}
    else:
        if not require_admin():
            return True
        auth = {"ok": True, "role": "admin", "username": "", "message": "admin"}

    if path == "/api/mesh/health":
        is_admin = auth.get("role") == "admin" or str(auth.get("username") or "").lower() in _ops_usernames()
        if not is_admin and auth.get("role") != "admin":
            # software non-ops: allow shallow health without secrets / control probe
            return handle_health(data_dir, send, deep=False, admin=False)
        return handle_health(data_dir, send, deep=True, admin=True)

    client_id = str((qs.get("clientId") or qs.get("client_id") or [""])[0] or "")
    gate = authorize_client_access(data_dir, auth, client_id, get_online_meta=get_online_meta)
    if not gate.get("ok"):
        send(403 if gate.get("code") == "FORBIDDEN" else 401, gate)
        return True
    return handle_status(data_dir, client_id, send)


def try_handle_post(
    path: str,
    body: Any,
    data_dir: Path,
    require_admin: Callable[[], bool],
    send: SendFn,
    *,
    headers: Any = None,
    check_admin_token: Optional[Callable[[str], bool]] = None,
    get_online_meta: Optional[Callable[[str], dict]] = None,
) -> bool:
    if path not in (
        "/api/mesh/session/desktop",
        "/api/mesh/session/files",
        "/api/mesh/bind",
        "/api/mesh/auto-bind",
    ):
        return False

    if headers is not None and check_admin_token is not None:
        auth = resolve_mesh_auth(headers, data_dir, check_admin_token=check_admin_token)
        if not auth.get("ok"):
            if not require_admin():
                return True
            auth = {"ok": True, "role": "admin", "username": "", "message": "admin"}
    else:
        if not require_admin():
            return True
        auth = {"ok": True, "role": "admin", "username": "", "message": "admin"}

    row = body if isinstance(body, dict) else {}
    client_id = str(row.get("clientId") or "").strip()
    gate = authorize_client_access(data_dir, auth, client_id, get_online_meta=get_online_meta)
    if not gate.get("ok"):
        send(403 if gate.get("code") == "FORBIDDEN" else 401, gate)
        return True

    if path == "/api/mesh/session/desktop":
        if auth.get("role") != "admin":
            send(403, {"ok": False, "code": "FORBIDDEN", "message": "仅管理员控制台可打开远控会话"})
            return True
        return handle_session_desktop(
            data_dir,
            row,
            send,
            owner_username=str(auth.get("username") or ""),
            get_online_meta=get_online_meta,
        )
    if path == "/api/mesh/session/files":
        if auth.get("role") != "admin":
            send(403, {"ok": False, "code": "FORBIDDEN", "message": "仅管理员控制台可打开文件会话"})
            return True
        return handle_session_files(
            data_dir,
            row,
            send,
            owner_username=str(auth.get("username") or ""),
            get_online_meta=get_online_meta,
        )
    if path == "/api/mesh/auto-bind":
        return handle_auto_bind(
            data_dir,
            row,
            send,
            owner_username=str(auth.get("username") or ""),
            get_online_meta=get_online_meta,
        )
    return handle_bind(data_dir, row, send, owner_username=str(auth.get("username") or ""))
