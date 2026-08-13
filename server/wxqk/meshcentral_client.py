"""
MeshCentral adapter for WXQK (optional subsystem).

Pinned target: MeshCentral **1.2.4**.
Never hard-fail wxqk startup. Prefer official login-token + embed URLs.
Do not invent REST paths. Keep settings.webRTC=false on the MeshCentral server.
"""

from __future__ import annotations

import base64
import json
import os
import secrets
import ssl
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Callable, Optional
from urllib.parse import quote, urlparse, urlunparse

# Optional WebSocket (soft dependency)
try:
    import websocket  # type: ignore
except Exception:  # pragma: no cover
    websocket = None  # type: ignore

try:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
except Exception:  # pragma: no cover
    AESGCM = None  # type: ignore


# Official MeshCentral embed viewmode values (docs.meshcentral.com):
# 11 = Device remote desktop, 12 = Device terminal, 13 = Device files
VIEWMODE_DESKTOP = 11
VIEWMODE_FILES = 13
VIEWMODE_TERMINAL = 12  # never open from product UI
# hide bitmask: 1 header + 2 tab + 4 footer + 8 title + 16 left toolbar + 32 back = 63
EMBED_HIDE = 63
# Default login cookie lifetime (minutes). MeshCentral 1.2.4 login URL decode uses
# timeout=60 when cookie has no expire; we always set expire explicitly (default 30).
DEFAULT_TOKEN_EXPIRE_MIN = 30
PINNED_MESHCENTRAL_VERSION = "1.2.4"

_MAP_LOCK = threading.RLock()
_MAP_NAME = "mesh_node_map.json"


def _env_bool(name: str, default: bool = False) -> bool:
    raw = str(os.environ.get(name, "") or "").strip().lower()
    if not raw:
        return default
    return raw in ("1", "true", "yes", "on")


def _env_int(name: str, default: int) -> int:
    try:
        return int(str(os.environ.get(name, "") or default).strip() or default)
    except Exception:
        return default


def is_enabled() -> bool:
    return _env_bool("WXQK_MESH_ENABLED", False)


def config_snapshot() -> dict[str, Any]:
    """Non-secret configuration for diagnostics."""
    return {
        "enabled": is_enabled(),
        "url": (os.environ.get("WXQK_MESH_URL") or "").rstrip("/"),
        "internalUrl": (os.environ.get("WXQK_MESH_INTERNAL_URL") or "").rstrip("/"),
        "user": os.environ.get("WXQK_MESH_USER") or "",
        "group": os.environ.get("WXQK_MESH_GROUP") or "",
        "timeout": _env_int("WXQK_MESH_TIMEOUT", 15),
        "loginKeyConfigured": bool(
            str(os.environ.get("WXQK_MESH_LOGIN_KEY") or os.environ.get("WXQK_MESH_SECRET") or "").strip()
        ),
    }


def _login_key_bytes() -> bytes:
    # WXQK_MESH_SECRET is an alias for the MeshCentral loginTokenKey hex.
    hex_key = str(
        os.environ.get("WXQK_MESH_LOGIN_KEY")
        or os.environ.get("WXQK_MESH_SECRET")
        or ""
    ).strip()
    if not hex_key:
        raise ValueError("WXQK_MESH_LOGIN_KEY (or WXQK_MESH_SECRET) missing")
    raw = bytes.fromhex(hex_key)
    if len(raw) < 32:
        raise ValueError("WXQK_MESH_LOGIN_KEY too short (need >= 32 bytes hex)")
    return raw[:32]


def _normalize_userid(userid: str) -> str:
    u = str(userid or "").strip()
    if not u:
        u = str(os.environ.get("WXQK_MESH_USER") or "user//admin").strip()
    if "//" not in u and not u.startswith("user/"):
        # MeshCentral user ids are typically "user//name" or "user/<domain>/<name>"
        u = f"user//{u}"
    return u


def mint_login_token(
    userid: str = "",
    *,
    style: str = "cookie",
    domainid: str = "",
    action: int = 3,
    expire_min: Optional[int] = None,
    now: Optional[Callable[[], float]] = None,
) -> str:
    """
    Mint a MeshCentral login cookie (AES-256-GCM), matching meshcentral.js encodeCookie.

    Verified against MeshCentral **1.2.4** source (tag 1.2.4):
      iv(12) || authTag(16) || ciphertext → base64, then +→@ and /→$
      Cookie JSON for URL ?login= uses {u, a, time[, expire]}
      webserver.js: decodeCookie(req.query.login, key, 60) — without `expire`,
      timeout argument is 60 minutes for login URL auth.
      With `expire` (minutes), cookie remains valid for that duration.
      Userid must be user/<domainid>/<name>; default domain → user//name
      (loginCookie.u.split('/')[1] == domain.id).

    Note: 1.2.3/1.2.4 "Login Token session" WS restrictions apply to user-created
    login tokens (req.session.loginToken), NOT to encodeCookie ?login= embed sessions.
    Our embed establishes a normal userid session (Desktop/Files unrestricted).

    styles:
      - cookie: {"u": userid, "a": 3, "time": ..., "expire": N}  (?login= / --logintoken)
      - control: {"userid": ..., "domainid": ..., "time": ..., "expire": N}  (control.ashx auth)
    """
    if AESGCM is None:
        raise RuntimeError("cryptography package required for MeshCentral login tokens")

    key = _login_key_bytes()
    ts = int((now or time.time)())
    uid = _normalize_userid(userid)
    expire = expire_min
    if expire is None:
        expire = _env_int("WXQK_MESH_TOKEN_EXPIRE_MIN", DEFAULT_TOKEN_EXPIRE_MIN)
    expire = max(2, min(int(expire), 24 * 60))  # clamp 2 min .. 24 h
    style_l = str(style or "cookie").strip().lower()
    if style_l == "control":
        payload: dict[str, Any] = {
            "userid": uid,
            "domainid": str(domainid or ""),
            "time": ts,
            "expire": expire,
        }
    else:
        payload = {"u": uid, "a": int(action), "time": ts, "expire": expire}

    plaintext = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    iv = secrets.token_bytes(12)
    aesgcm = AESGCM(key)
    # AESGCM.encrypt returns ciphertext || tag (16 bytes)
    ct_with_tag = aesgcm.encrypt(iv, plaintext, None)
    ciphertext, tag = ct_with_tag[:-16], ct_with_tag[-16:]
    # MeshCentral: iv + tag + ciphertext, base64 with +/ → @$
    blob = iv + tag + ciphertext
    token = base64.b64encode(blob, altchars=b"@$").decode("ascii").rstrip("=")
    return token


def public_url() -> str:
    return str(os.environ.get("WXQK_MESH_URL") or "").strip().rstrip("/")


def internal_url() -> str:
    return str(os.environ.get("WXQK_MESH_INTERNAL_URL") or "").strip().rstrip("/") or public_url()


def normalize_node_query_id(node_id: str) -> str:
    """
    MeshCentral 1.2.4 webserver.js handleRootRequestEx builds:
      currentNode = 'node/' + domain.id + '/' + req.query.node
    So ?node= must be the leaf id only (not full 'node//…' / 'node/<domain>/…').
    Official docs also show ?node=<base64-id>&viewmode=11.
    """
    nid = str(node_id or "").strip()
    if not nid:
        return ""
    # "node//leaf" → ["node", "", "leaf"]; "node/domain/leaf" → three parts
    raw_parts = nid.split("/")
    if len(raw_parts) >= 3 and raw_parts[0] == "node":
        return raw_parts[-1]
    if len(raw_parts) == 1:
        return nid
    return raw_parts[-1]


def build_embed_url(node_id: str, viewmode: int, *, userid: str = "", login_token: str = "") -> str:
    """
    Official embed URL (MeshCentral 1.2.4 docs + default.handlebars):
      {url}/?login={token}&node={leafNodeId}&viewmode={11|13}&hide={mask}

    viewmode 11 = desktop, 13 = files. Do not use 12 (terminal) from product UI.
    hide defaults to 63 (chrome + left toolbar + back) for product-only Desktop/Files.

    Login cookie: webserver.js decodeCookie(query.login, key, 60) — 60 min default
    timeout when cookie has no `expire`; we always set `expire` explicitly.
    Domain check: loginCookie.u.split('/')[1] must equal domain.id (default → user//name).
    """
    base = public_url()
    if not base:
        raise ValueError("WXQK_MESH_URL missing")
    nid = normalize_node_query_id(node_id)
    if not nid:
        raise ValueError("node_id required")
    # Reject renderer-supplied node ids that look like path injection
    if any(ch in nid for ch in ("\n", "\r", " ", "?", "/")):
        raise ValueError("invalid node_id")
    vm = int(viewmode)
    if vm == VIEWMODE_TERMINAL:
        raise ValueError("terminal viewmode is discouraged; use 11 (desktop) or 13 (files)")
    if vm not in (VIEWMODE_DESKTOP, VIEWMODE_FILES):
        raise ValueError(f"unsupported viewmode {vm}")
    token = login_token or mint_login_token(userid or _normalize_userid(""))
    q = (
        f"login={quote(token, safe='')}"
        f"&node={quote(nid, safe='')}"
        f"&viewmode={vm}"
        f"&hide={EMBED_HIDE}"
    )
    return f"{base}/?{q}"


def _ssl_context_for_url(url: str) -> ssl.SSLContext | None:
    """TLS verify always on for https; optional WXQK_MESH_TLS_CA for IP / private CA."""
    if not str(url or "").lower().startswith("https"):
        return None
    ctx = ssl.create_default_context()
    ca = str(os.environ.get("WXQK_MESH_TLS_CA") or "").strip()
    if ca:
        ctx.load_verify_locations(ca)
    return ctx


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[override]
        return None


def _http_get(url: str, timeout: float, *, follow_redirects: bool = True) -> tuple[int, bytes, str]:
    """
    GET url. Returns (status, body, final_url).
    When follow_redirects is False, 3xx is returned as-is (Mesh HTTP often 302→HTTPS).
    """
    req = urllib.request.Request(url, method="GET", headers={"User-Agent": "wxqk-meshcentral-client/1.0"})
    handlers: list[Any] = []
    if not follow_redirects:
        handlers.append(_NoRedirect())
    ctx = _ssl_context_for_url(url)
    if ctx is not None:
        handlers.append(urllib.request.HTTPSHandler(context=ctx))
    opener = urllib.request.build_opener(*handlers)
    try:
        with opener.open(req, timeout=timeout) as resp:
            return int(getattr(resp, "status", 200) or 200), resp.read(65536), str(getattr(resp, "geturl", lambda: url)())
    except urllib.error.HTTPError as exc:
        # Redirect handler raises HTTPError when redirect is blocked
        if exc.code and 300 <= int(exc.code) < 400:
            return int(exc.code), (exc.read(4096) if hasattr(exc, "read") else b""), url
        raise


def health_check(*, deep: bool = False) -> dict[str, Any]:
    """
    Soft MeshCentral health for diagnostics.
    Never returns login keys / cookies / passwords.
    deep=True also probes control.ashx when websocket is available.
    """
    snap = config_snapshot()
    if not is_enabled():
        return {
            "ok": False,
            "code": "MESH_DISABLED",
            "message": "MeshCentral 未启用",
            "enabled": False,
            "meshReachable": False,
            "controlChannel": False,
            "loginKeyConfigured": bool(snap.get("loginKeyConfigured")),
            "version": PINNED_MESHCENTRAL_VERSION,
            "webRtcDisabled": True,
            "userMessage": "远程维护服务器未配置",
        }
    timeout = float(_env_int("WXQK_MESH_TIMEOUT", 15))
    targets = []
    for u in (internal_url(), public_url()):
        if u and u not in targets:
            targets.append(u)
    if not targets:
        return {
            "ok": False,
            "code": "MESH_URL_MISSING",
            "message": "未配置 WXQK_MESH_URL",
            "enabled": True,
            "meshReachable": False,
            "controlChannel": False,
            "loginKeyConfigured": bool(snap.get("loginKeyConfigured")),
            "version": PINNED_MESHCENTRAL_VERSION,
            "webRtcDisabled": True,
            "userMessage": "远程维护服务器未配置",
        }

    errors: list[str] = []
    reachable = False
    status_code = 0
    used_url = ""
    for url in targets:
        try:
            follow = not url.lower().startswith("http://127.0.0.1") and not url.lower().startswith("http://localhost")
            status, body, final = _http_get(url, timeout, follow_redirects=follow)
            ok = status < 500
            reachable = ok
            status_code = status
            used_url = url
            if ok:
                break
            errors.append(f"{url}: HTTP {status}")
        except Exception as exc:
            errors.append(f"{url}: {exc}")

    control_ok = False
    control_code = ""
    if deep and reachable and snap.get("loginKeyConfigured"):
        synced = sync_nodes_via_control(timeout=min(timeout, 8.0))
        control_ok = bool(synced.get("ok"))
        control_code = str(synced.get("code") or "")
        if not control_ok:
            errors.append(str(synced.get("message") or control_code or "control failed")[:160])

    if not reachable:
        return {
            "ok": False,
            "code": "MESH_UNREACHABLE",
            "message": "MeshCentral 不可达",
            "enabled": True,
            "meshReachable": False,
            "controlChannel": False,
            "loginKeyConfigured": bool(snap.get("loginKeyConfigured")),
            "version": PINNED_MESHCENTRAL_VERSION,
            "webRtcDisabled": True,
            "errors": errors[:5],
            "userMessage": "远程维护服务器不可达",
        }

    ok = reachable and bool(snap.get("loginKeyConfigured"))
    if deep:
        ok = ok and control_ok
    return {
        "ok": ok,
        "code": "OK" if ok else (
            "MESH_CONTROL_FAILED" if deep and reachable and not control_ok
            else ("MESH_KEY_MISSING" if reachable and not snap.get("loginKeyConfigured") else "MESH_PARTIAL")
        ),
        "message": "MeshCentral 可达" if reachable else "MeshCentral 不可达",
        "enabled": True,
        "meshReachable": True,
        "controlChannel": bool(control_ok) if deep else None,
        "loginKeyConfigured": bool(snap.get("loginKeyConfigured")),
        "version": PINNED_MESHCENTRAL_VERSION,
        "webRtcDisabled": True,
        "statusCode": status_code,
        "url": used_url,
        "errors": errors[:5],
        "userMessage": (
            "远程维护服务正常" if ok
            else ("远程维护服务器未配置" if not snap.get("loginKeyConfigured") else "远程维护服务器不可达")
        ),
    }


def _map_path(data_dir: Path) -> Path:
    security = Path(data_dir) / "security"
    security.mkdir(parents=True, exist_ok=True)
    return security / _MAP_NAME


def _read_map(data_dir: Path) -> dict[str, Any]:
    path = _map_path(data_dir)
    if not path.exists():
        return {"version": 1, "devices": []}
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            return {"version": 1, "devices": []}
        devices = raw.get("devices")
        if not isinstance(devices, list):
            raw["devices"] = []
        return raw
    except Exception:
        return {"version": 1, "devices": []}


def _write_map(data_dir: Path, data: dict[str, Any]) -> None:
    path = _map_path(data_dir)
    tmp = path.with_suffix(".tmp")
    payload = json.dumps(data, ensure_ascii=False, indent=2)
    tmp.write_text(payload, encoding="utf-8")
    tmp.replace(path)


def _utcnow_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def get_mapping(data_dir: Path, client_id: str) -> Optional[dict[str, Any]]:
    cid = str(client_id or "").strip()
    if not cid:
        return None
    with _MAP_LOCK:
        data = _read_map(data_dir)
        for row in data.get("devices") or []:
            if isinstance(row, dict) and str(row.get("client_id") or "") == cid:
                return dict(row)
    return None


def sync_device_mapping(
    data_dir: Path,
    *,
    client_id: str,
    mesh_node_id: str = "",
    mesh_group_id: str = "",
    mesh_agent_status: str = "",
    mesh_last_seen: str = "",
    owner_username: str = "",
    **_extra: Any,
) -> dict[str, Any]:
    cid = str(client_id or "").strip()
    if not cid:
        raise ValueError("client_id required")
    now = _utcnow_iso()
    with _MAP_LOCK:
        data = _read_map(data_dir)
        devices = [d for d in (data.get("devices") or []) if isinstance(d, dict)]
        found = None
        for row in devices:
            if str(row.get("client_id") or "") == cid:
                found = row
                break
        if found is None:
            found = {
                "client_id": cid,
                "mesh_node_id": "",
                "mesh_group_id": "",
                "mesh_agent_status": "",
                "mesh_last_seen": "",
                "owner_username": "",
                "created_at": now,
                "updated_at": now,
            }
            devices.append(found)
        if mesh_node_id:
            found["mesh_node_id"] = str(mesh_node_id).strip()
        if mesh_group_id:
            found["mesh_group_id"] = str(mesh_group_id).strip()
        elif not found.get("mesh_group_id"):
            found["mesh_group_id"] = str(os.environ.get("WXQK_MESH_GROUP") or "").strip()
        if mesh_agent_status:
            found["mesh_agent_status"] = str(mesh_agent_status).strip()
        if owner_username:
            found["owner_username"] = str(owner_username).strip()[:80]
        if mesh_last_seen:
            found["mesh_last_seen"] = str(mesh_last_seen).strip()
        found["updated_at"] = now
        data["version"] = 1
        data["devices"] = devices
        _write_map(data_dir, data)
        return dict(found)


def list_mappings(data_dir: Path) -> list[dict[str, Any]]:
    with _MAP_LOCK:
        data = _read_map(data_dir)
        return [dict(d) for d in (data.get("devices") or []) if isinstance(d, dict)]


def _ws_sslopt(url: str) -> dict[str, Any]:
    """TLS options for control.ashx — always verify; optional custom CA for IP certs."""
    if not url.startswith("wss://"):
        return {}
    ctx = ssl.create_default_context()
    ca = str(os.environ.get("WXQK_MESH_TLS_CA") or "").strip()
    if ca and Path(ca).is_file():
        ctx.load_verify_locations(ca)
    return {"cert_reqs": ssl.CERT_REQUIRED, "context": ctx}


def _open_control_websocket(url: str, timeout_s: float):
    """
    Open control.ashx with TLS verify.

    MeshCentral 1.2.4 closes control sockets with cause=invalidorigin when an Origin
    header is present but not accepted for server-side control sync. Server→Mesh
    sync therefore omits Origin by default. Set WXQK_MESH_WS_ORIGIN to force one.
    When WXQK_MESH_WS_LOCAL_HOST is set (e.g. 127.0.0.1), TCP connects locally
    while keeping Host/SNI as the public Mesh URL — required on the MeshCentral
    host itself (no hairpin NAT to its own public IP).
    """
    import socket

    origin = str(os.environ.get("WXQK_MESH_WS_ORIGIN") or "").strip()
    header = [f"Origin: {origin}"] if origin else None
    sslopt = _ws_sslopt(url)
    local_host = str(os.environ.get("WXQK_MESH_WS_LOCAL_HOST") or "").strip()
    if local_host and url.startswith("wss://"):
        parsed = urlparse(url)
        port = parsed.port or 443
        raw = socket.create_connection((local_host, port), timeout=timeout_s)
        ctx = ssl.create_default_context()
        ca = str(os.environ.get("WXQK_MESH_TLS_CA") or "").strip()
        if ca and Path(ca).is_file():
            ctx.load_verify_locations(ca)
            # Production currently serves an IP certificate via nginx; after trusting
            # that cert as CA, hostname matching is not meaningful for the IP CN.
            ctx.check_hostname = False
        ssock = ctx.wrap_socket(raw, server_hostname=parsed.hostname or local_host)
        return websocket.create_connection(
            url,
            socket=ssock,
            timeout=timeout_s,
            origin=origin or None,
            header=header,
            host=parsed.netloc,
        )
    return websocket.create_connection(
        url,
        timeout=timeout_s,
        sslopt=sslopt,
        origin=origin or None,
        header=header,
    )


def _ws_url_for_control(auth_token: str) -> str:
    # Prefer public HTTPS URL so Host/Origin/SNI align with MeshCentral Cert+AliasPort.
    # Internal plain HTTP (TlsOffload loopback) often fails origin checks.
    base = public_url() or internal_url()
    if not base:
        raise ValueError("WXQK_MESH_URL missing")
    parsed = urlparse(base)
    scheme = "wss" if parsed.scheme == "https" else "ws"
    if parsed.scheme == "http" and parsed.hostname in ("127.0.0.1", "localhost"):
        scheme = "ws"
    elif parsed.scheme == "https":
        scheme = "wss"
    netloc = parsed.netloc
    path = "/control.ashx"
    query = f"auth={quote(auth_token, safe='')}"
    return urlunparse((scheme, netloc, path, "", query, ""))


def sync_nodes_via_control(
    *,
    userid: str = "",
    timeout: Optional[float] = None,
) -> dict[str, Any]:
    """
    List nodes via WebSocket control.ashx when possible.
    Soft-fails if websocket-client is missing or server unreachable.
    """
    if not is_enabled():
        return {"ok": False, "code": "MESH_DISABLED", "message": "MeshCentral 未启用", "nodes": []}
    if websocket is None:
        return {
            "ok": False,
            "code": "MESH_WS_UNAVAILABLE",
            "message": "websocket-client 未安装，无法同步节点",
            "nodes": [],
        }
    timeout_s = float(timeout if timeout is not None else _env_int("WXQK_MESH_TIMEOUT", 15))
    try:
        # control.ashx community examples use the control-style cookie
        token = mint_login_token(userid, style="control")
        url = _ws_url_for_control(token)
    except Exception as exc:
        return {"ok": False, "code": "MESH_TOKEN_ERROR", "message": str(exc), "nodes": []}

    nodes: list[dict[str, Any]] = []
    meshes: list[dict[str, Any]] = []
    errors: list[str] = []
    got_nodes = False

    try:
        # Always verify TLS for wss:// — never CERT_NONE / rejectUnauthorized bypass.
        # Origin omitted by default (see _open_control_websocket); optional local TCP via WXQK_MESH_WS_LOCAL_HOST.
        ws = _open_control_websocket(url, timeout_s)
        try:
            # Request device groups then nodes (MeshCtrl-style).
            ws.send(json.dumps({"action": "meshes", "responseid": "wxqk-meshes"}))
            ws.send(json.dumps({"action": "nodes", "responseid": "wxqk-nodes"}))
            deadline = time.time() + timeout_s
            while time.time() < deadline:
                remaining = max(0.1, deadline - time.time())
                ws.settimeout(remaining)
                try:
                    raw = ws.recv()
                except Exception:
                    break
                if not raw:
                    continue
                try:
                    msg = json.loads(raw)
                except Exception:
                    continue
                if not isinstance(msg, dict):
                    continue
                action = str(msg.get("action") or "")
                if action == "meshes":
                    m = msg.get("meshes") or msg.get("result") or []
                    if isinstance(m, list):
                        meshes = [x for x in m if isinstance(x, dict)]
                elif action == "nodes":
                    n = msg.get("nodes") or msg.get("result") or []
                    if isinstance(n, dict):
                        # Some servers return {meshid: [nodes...]}
                        for arr in n.values():
                            if isinstance(arr, list):
                                nodes.extend([x for x in arr if isinstance(x, dict)])
                    elif isinstance(n, list):
                        nodes = [x for x in n if isinstance(x, dict)]
                    got_nodes = True
                    break
            if not got_nodes and not nodes:
                errors.append("nodes_response_timeout")
        finally:
            try:
                ws.close()
            except Exception:
                pass
    except Exception as exc:
        return {
            "ok": False,
            "code": "MESH_WS_ERROR",
            "message": str(exc),
            "nodes": [],
            "meshes": [],
        }

    if not got_nodes and not nodes:
        return {
            "ok": False,
            "code": "MESH_SYNC_FAILED",
            "message": "控制通道未返回节点列表（可能是 Origin/鉴权失败）",
            "nodes": [],
            "meshes": meshes,
            "errors": errors,
        }

    return {
        "ok": True,
        "code": "OK",
        "message": "ok",
        "nodes": nodes,
        "meshes": meshes,
        "errors": errors,
    }


def _node_text_blob(node: dict[str, Any]) -> str:
    parts: list[str] = []
    for key in ("name", "host", "hostname", "desc", "osdesc", "agent", "ip", "_id", "nodeid", "id"):
        val = node.get(key)
        if val is not None:
            parts.append(str(val))
    tags = node.get("tags") or node.get("tag") or []
    if isinstance(tags, (list, tuple)):
        parts.extend(str(t) for t in tags)
    elif tags:
        parts.append(str(tags))
    return " ".join(parts).lower()


def agent_name_for_client(client_id: str) -> str:
    cid = str(client_id or "").strip()
    return f"WXQK-{cid}" if cid else ""


# Live readiness states (mapping alone is never "ready")
REMOTE_STATE_UNBOUND = "unbound"
REMOTE_STATE_PREPARING = "preparing"
REMOTE_STATE_BOUND_OFFLINE = "bound_offline"
REMOTE_STATE_READY = "ready"
REMOTE_STATE_ERROR = "error"
REMOTE_STATE_UNVERIFIED = "unverified"

# Short TTL cache for MeshCentral live node queries (seconds)
_LIVE_STATUS_TTL_S = float(_env_int("WXQK_MESH_LIVE_CACHE_TTL", 5))
_LIVE_STATUS_CACHE: dict[str, tuple[float, dict[str, Any]]] = {}
_LIVE_STATUS_LOCK = threading.RLock()


def _live_cache_get(key: str) -> Optional[dict[str, Any]]:
    now = time.time()
    with _LIVE_STATUS_LOCK:
        row = _LIVE_STATUS_CACHE.get(key)
        if not row:
            return None
        expires_at, payload = row
        if now >= expires_at:
            _LIVE_STATUS_CACHE.pop(key, None)
            return None
        return dict(payload)


def _live_cache_set(key: str, payload: dict[str, Any], ttl_s: Optional[float] = None) -> None:
    ttl = _LIVE_STATUS_TTL_S if ttl_s is None else float(ttl_s)
    with _LIVE_STATUS_LOCK:
        _LIVE_STATUS_CACHE[key] = (time.time() + max(0.5, ttl), dict(payload))


def clear_live_status_cache() -> None:
    """Test helper — drop all live status cache entries."""
    with _LIVE_STATUS_LOCK:
        _LIVE_STATUS_CACHE.clear()


def node_is_online(node: Optional[dict[str, Any]]) -> bool:
    """
    MeshCentral 1.2.4 node online signal:
      - conn bitmask / int > 0 (agent connected)
      - or explicit online truthy
    """
    if not isinstance(node, dict):
        return False
    online = node.get("online")
    if online in (True, 1, "1", "true", "True", "yes", "YES"):
        return True
    if online in (False, 0, "0", "false", "False"):
        return False
    conn = node.get("conn")
    if conn is None:
        return False
    try:
        return int(conn) > 0
    except Exception:
        return bool(conn)


def find_node_by_id(nodes: list[dict[str, Any]], mesh_node_id: str) -> Optional[dict[str, Any]]:
    want = str(mesh_node_id or "").strip()
    if not want:
        return None
    want_leaf = want.split("/")[-1]
    for node in nodes or []:
        if not isinstance(node, dict):
            continue
        nid = node_id_of(node)
        if not nid:
            continue
        if nid == want or nid.split("/")[-1] == want_leaf:
            return node
    return None


def _node_still_present(nodes: list[dict[str, Any]], mesh_node_id: str) -> bool:
    return find_node_by_id(nodes, mesh_node_id) is not None


def match_node_for_client(
    nodes: list[dict[str, Any]],
    client_id: str,
    *,
    hostname: str = "",
    allow_hostname_fallback: bool = True,
) -> tuple[Optional[dict[str, Any]], str]:
    """
    Match priority:
      1) exact agentName / name == WXQK-<clientId>
      2) exact name/host == clientId (legacy)
      3) unique hostname fallback (old-client migration only)

    Returns (node_or_None, error_code).
    error_code empty on success; MESH_AMBIGUOUS / MESH_HOSTNAME_AMBIGUOUS / MESH_NO_MATCH / BAD_REQUEST.
    """
    cid = str(client_id or "").strip()
    if not cid:
        return None, "BAD_REQUEST"
    cid_l = cid.lower()
    agent_name = agent_name_for_client(cid).lower()
    host_hint = str(hostname or "").strip().lower()

    by_agent: list[dict[str, Any]] = []
    by_client_id: list[dict[str, Any]] = []
    by_hostname: list[dict[str, Any]] = []

    for node in nodes or []:
        if not isinstance(node, dict):
            continue
        name = str(node.get("name") or "").strip().lower()
        host = str(node.get("host") or node.get("hostname") or "").strip().lower()
        agent_field = str(node.get("agentName") or node.get("agentname") or "").strip().lower()
        # MeshAgent agentName is exposed primarily as the device "name"
        if name == agent_name or agent_field == agent_name:
            by_agent.append(node)
        elif name == cid_l or host == cid_l:
            by_client_id.append(node)
        if host_hint and (name == host_hint or host == host_hint or agent_field == host_hint):
            by_hostname.append(node)

    def _prefer_online(
        candidates: list[dict[str, Any]],
        *,
        ambiguous_code: str,
    ) -> tuple[Optional[dict[str, Any]], str]:
        """When reinstall leaves duplicate names, prefer the single online node."""
        if len(candidates) == 1:
            return candidates[0], ""
        online = [n for n in candidates if node_is_online(n)]
        if len(online) == 1:
            return online[0], ""
        return None, ambiguous_code

    if by_agent:
        return _prefer_online(by_agent, ambiguous_code="MESH_AMBIGUOUS")

    if by_client_id:
        return _prefer_online(by_client_id, ambiguous_code="MESH_AMBIGUOUS")

    if allow_hostname_fallback and host_hint and by_hostname:
        return _prefer_online(by_hostname, ambiguous_code="MESH_HOSTNAME_AMBIGUOUS")

    return None, "MESH_NO_MATCH"


def node_id_of(node: dict[str, Any]) -> str:
    if not isinstance(node, dict):
        return ""
    for key in ("_id", "nodeid", "id", "nodeId"):
        val = str(node.get(key) or "").strip()
        if val:
            return val
    return ""


def _bind_result_payload(
    *,
    ok: bool,
    code: str,
    message: str,
    user_message: str = "",
    remote_state: str,
    mapping: Optional[dict[str, Any]] = None,
    mesh_node_id: str = "",
    agent_name: str = "",
    online: bool = False,
    verified: bool = False,
    extra: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    nid = str(mesh_node_id or (mapping or {}).get("mesh_node_id") or "").strip()
    bound = bool(nid)
    ready = bool(ok and verified and online and bound and remote_state == REMOTE_STATE_READY)
    out: dict[str, Any] = {
        "ok": bool(ok) if remote_state != REMOTE_STATE_READY else bool(ready),
        "code": code,
        "message": message,
        "userMessage": user_message or message,
        "remoteState": remote_state,
        "bound": bound,
        "online": bool(online),
        "ready": ready,
        "verified": bool(verified),
        "meshNodeId": nid,
        "mapping": mapping,
    }
    if remote_state == REMOTE_STATE_READY and ready:
        out["ok"] = True
    elif remote_state in (
        REMOTE_STATE_BOUND_OFFLINE,
        REMOTE_STATE_PREPARING,
        REMOTE_STATE_UNVERIFIED,
        REMOTE_STATE_UNBOUND,
    ):
        out["ok"] = False
    if agent_name:
        out["agentName"] = agent_name
    if extra:
        out.update(extra)
    return out


def _persist_matched_mapping(
    data_dir: Path,
    *,
    client_id: str,
    matched: dict[str, Any],
    owner_username: str = "",
) -> dict[str, Any]:
    nid = node_id_of(matched)
    group_id = str(matched.get("meshid") or matched.get("meshId") or matched.get("mesh") or "").strip()
    online = node_is_online(matched)
    return sync_device_mapping(
        data_dir,
        client_id=client_id,
        mesh_node_id=nid,
        mesh_group_id=group_id,
        mesh_agent_status="online" if online else "bound",
        mesh_last_seen=_utcnow_iso(),
        owner_username=owner_username,
    )


def auto_bind_client(
    data_dir: Path,
    client_id: str,
    *,
    owner_username: str = "",
    userid: str = "",
    hostname: str = "",
    allow_hostname_fallback: bool = True,
    agent_name: str = "",
) -> dict[str, Any]:
    """
    Sync MeshCentral nodes and bind clientId ↔ meshNodeId.

    Priority:
      1) agentName == WXQK-<clientId>
      2) existing DB mapping if node still present
      3) unique hostname fallback (legacy migration only)

    Remaps when old mapped node is gone and a new agentName node appears.

    Important:
      - Control query failure keeps historical mapping but never reports ready.
      - Authoritative empty node list never treats stale mapping as live-ready.
      - Session/status readiness requires the mapped node to be online.
    """
    if not is_enabled():
        return {
            "ok": False,
            "code": "MESH_DISABLED",
            "message": "MeshCentral 未启用",
            "userMessage": "远程服务不可用",
            "remoteState": REMOTE_STATE_ERROR,
            "bound": False,
            "online": False,
            "ready": False,
            "verified": False,
        }
    cid = str(client_id or "").strip()
    if not cid:
        return {
            "ok": False,
            "code": "BAD_REQUEST",
            "message": "clientId 必填",
            "userMessage": "远程服务准备失败",
            "remoteState": REMOTE_STATE_ERROR,
            "bound": False,
            "online": False,
            "ready": False,
            "verified": False,
        }
    host_hint = str(hostname or "").strip()
    expected_agent = str(agent_name or "").strip() or agent_name_for_client(cid)
    existing = get_mapping(data_dir, cid)
    existing_nid = str((existing or {}).get("mesh_node_id") or "").strip()

    synced = sync_nodes_via_control(userid=userid)
    if not synced.get("ok"):
        return _bind_result_payload(
            ok=False,
            code=str(synced.get("code") or "MESH_SYNC_FAILED"),
            message=str(synced.get("message") or "同步节点失败"),
            user_message="正在等待设备上线…",
            remote_state=REMOTE_STATE_UNVERIFIED if existing_nid else REMOTE_STATE_PREPARING,
            mapping=existing,
            mesh_node_id=existing_nid,
            agent_name=expected_agent,
            online=False,
            verified=False,
            extra={"nodes": synced.get("nodes") or []},
        )

    nodes = [n for n in (synced.get("nodes") or []) if isinstance(n, dict)]
    matched, match_err = match_node_for_client(
        nodes,
        cid,
        hostname=host_hint,
        allow_hostname_fallback=allow_hostname_fallback,
    )

    if existing_nid:
        present = find_node_by_id(nodes, existing_nid)
        if present is not None:
            online = node_is_online(present)
            if online:
                sync_device_mapping(
                    data_dir,
                    client_id=cid,
                    mesh_node_id=existing_nid,
                    mesh_agent_status="online",
                    mesh_last_seen=_utcnow_iso(),
                    owner_username=owner_username,
                )
                mapping = get_mapping(data_dir, cid) or existing
                return _bind_result_payload(
                    ok=True,
                    code="OK",
                    message="already bound",
                    user_message="服务已就绪",
                    remote_state=REMOTE_STATE_READY,
                    mapping=mapping,
                    mesh_node_id=existing_nid,
                    agent_name=expected_agent,
                    online=True,
                    verified=True,
                )
            # Stale offline mapping: if a newer duplicate agentName node is online, remapping.
            if matched and node_is_online(matched) and node_id_of(matched) != existing_nid:
                mapping = _persist_matched_mapping(
                    data_dir,
                    client_id=cid,
                    matched=matched,
                    owner_username=owner_username,
                )
                new_nid = node_id_of(matched)
                return _bind_result_payload(
                    ok=True,
                    code="OK",
                    message="remapped from offline duplicate",
                    user_message="服务已就绪",
                    remote_state=REMOTE_STATE_READY,
                    mapping=mapping,
                    mesh_node_id=new_nid,
                    agent_name=expected_agent,
                    online=True,
                    verified=True,
                )
            sync_device_mapping(
                data_dir,
                client_id=cid,
                mesh_node_id=existing_nid,
                mesh_agent_status="bound",
                mesh_last_seen=_utcnow_iso(),
                owner_username=owner_username,
            )
            mapping = get_mapping(data_dir, cid) or existing
            return _bind_result_payload(
                ok=False,
                code="MESH_AGENT_OFFLINE",
                message="设备当前离线",
                user_message="正在等待客户端远程服务上线…",
                remote_state=REMOTE_STATE_BOUND_OFFLINE,
                mapping=mapping,
                mesh_node_id=existing_nid,
                agent_name=expected_agent,
                online=False,
                verified=True,
            )

        if matched:
            new_nid = node_id_of(matched)
            if new_nid:
                mapping = _persist_matched_mapping(
                    data_dir,
                    client_id=cid,
                    matched=matched,
                    owner_username=owner_username,
                )
                online = node_is_online(matched)
                if online:
                    return _bind_result_payload(
                        ok=True,
                        code="OK",
                        message="remapped after agent reinstall",
                        user_message="服务已就绪",
                        remote_state=REMOTE_STATE_READY,
                        mapping=mapping,
                        mesh_node_id=new_nid,
                        agent_name=expected_agent,
                        online=True,
                        verified=True,
                    )
                return _bind_result_payload(
                    ok=False,
                    code="MESH_AGENT_OFFLINE",
                    message="设备当前离线",
                    user_message="正在等待客户端远程服务上线…",
                    remote_state=REMOTE_STATE_BOUND_OFFLINE,
                    mapping=mapping,
                    mesh_node_id=new_nid,
                    agent_name=expected_agent,
                    online=False,
                    verified=True,
                )

    if match_err in ("MESH_AMBIGUOUS", "MESH_HOSTNAME_AMBIGUOUS"):
        return _bind_result_payload(
            ok=False,
            code=match_err,
            message="发现重复设备，无法自动绑定",
            user_message="发现重复设备",
            remote_state=REMOTE_STATE_ERROR,
            mapping=existing,
            mesh_node_id=existing_nid,
            agent_name=expected_agent,
            online=False,
            verified=True,
            extra={"nodeCount": len(nodes), "hostname": host_hint or None},
        )

    if not matched:
        return _bind_result_payload(
            ok=False,
            code=match_err or "MESH_NO_MATCH",
            message="未找到可绑定的远程设备（Agent 可能尚未上线）",
            user_message="正在等待客户端上线…",
            remote_state=REMOTE_STATE_PREPARING if not existing_nid else REMOTE_STATE_UNBOUND,
            mapping=existing,
            mesh_node_id=existing_nid,
            agent_name=expected_agent,
            online=False,
            verified=True,
            extra={"nodeCount": len(nodes), "hostname": host_hint or None},
        )

    nid = node_id_of(matched)
    if not nid:
        return _bind_result_payload(
            ok=False,
            code="MESH_NODE_ID_MISSING",
            message="匹配节点缺少 node id",
            user_message="远程服务准备失败",
            remote_state=REMOTE_STATE_ERROR,
            mapping=existing,
            agent_name=expected_agent,
            online=False,
            verified=True,
        )
    mapping = _persist_matched_mapping(
        data_dir,
        client_id=cid,
        matched=matched,
        owner_username=owner_username,
    )
    online = node_is_online(matched)
    if online:
        return _bind_result_payload(
            ok=True,
            code="OK",
            message="auto bound",
            user_message="服务已就绪",
            remote_state=REMOTE_STATE_READY,
            mapping=mapping,
            mesh_node_id=nid,
            agent_name=expected_agent,
            online=True,
            verified=True,
        )
    return _bind_result_payload(
        ok=False,
        code="MESH_AGENT_OFFLINE",
        message="设备当前离线",
        user_message="正在等待客户端远程服务上线…",
        remote_state=REMOTE_STATE_BOUND_OFFLINE,
        mapping=mapping,
        mesh_node_id=nid,
        agent_name=expected_agent,
        online=False,
        verified=True,
    )


def resolve_live_device_status(
    data_dir: Path,
    client_id: str,
    *,
    userid: str = "",
    hostname: str = "",
    owner_username: str = "",
    force_refresh: bool = False,
) -> dict[str, Any]:
    """
    Live status for a clientId. Database mapping is cache only — never proof of readiness.
    Uses a short TTL cache to avoid hammering control.ashx.
    """
    if not is_enabled():
        return {
            "ok": False,
            "code": "MESH_DISABLED",
            "message": "远程服务不可用",
            "userMessage": "远程服务不可用",
            "clientId": client_id,
            "bound": False,
            "online": False,
            "ready": False,
            "verified": False,
            "remoteState": REMOTE_STATE_ERROR,
        }
    cid = str(client_id or "").strip()
    if not cid:
        return {
            "ok": False,
            "code": "BAD_REQUEST",
            "message": "clientId 必填",
            "userMessage": "远程服务准备失败",
            "clientId": "",
            "bound": False,
            "online": False,
            "ready": False,
            "verified": False,
            "remoteState": REMOTE_STATE_ERROR,
        }

    cache_key = f"status:{cid}"
    if not force_refresh:
        cached = _live_cache_get(cache_key)
        if cached is not None:
            return cached

    row = get_mapping(data_dir, cid)
    node_id = str((row or {}).get("mesh_node_id") or "").strip() if row else ""
    if not node_id:
        bound = auto_bind_client(
            data_dir,
            cid,
            owner_username=owner_username,
            userid=userid,
            hostname=hostname,
        )
        payload = {
            "ok": True,
            "code": str(bound.get("code") or "MESH_PREPARING"),
            "message": str(bound.get("message") or "正在准备服务…"),
            "userMessage": str(bound.get("userMessage") or bound.get("message") or "正在准备服务…"),
            "clientId": cid,
            "bound": bool(bound.get("bound")),
            "online": bool(bound.get("online")),
            "ready": bool(bound.get("ready")),
            "verified": bool(bound.get("verified")),
            "remoteState": str(bound.get("remoteState") or REMOTE_STATE_PREPARING),
            "mapping": bound.get("mapping") or row,
            "meshNodeId": str(bound.get("meshNodeId") or ""),
            "config": config_snapshot(),
        }
        if payload["ready"]:
            payload["code"] = "OK"
            payload["message"] = "服务已就绪"
            payload["userMessage"] = "服务已就绪"
        elif not payload["bound"]:
            payload["code"] = "MESH_PREPARING"
            payload["message"] = "正在准备服务…"
            payload["userMessage"] = "正在准备服务…"
            payload["remoteState"] = REMOTE_STATE_PREPARING
        _live_cache_set(cache_key, payload)
        return payload

    synced = sync_nodes_via_control(userid=userid)
    if not synced.get("ok"):
        payload = {
            "ok": True,
            "code": str(synced.get("code") or "MESH_SYNC_FAILED"),
            "message": str(synced.get("message") or "暂时无法确认设备在线状态"),
            "userMessage": "正在等待设备上线…",
            "clientId": cid,
            "bound": True,
            "online": False,
            "ready": False,
            "verified": False,
            "remoteState": REMOTE_STATE_UNVERIFIED,
            "mapping": row,
            "meshNodeId": node_id,
            "config": config_snapshot(),
        }
        _live_cache_set(cache_key, payload, ttl_s=min(2.0, _LIVE_STATUS_TTL_S))
        return payload

    nodes = [n for n in (synced.get("nodes") or []) if isinstance(n, dict)]
    present = find_node_by_id(nodes, node_id)
    if present is None:
        remapped = auto_bind_client(
            data_dir,
            cid,
            owner_username=owner_username,
            userid=userid,
            hostname=hostname,
        )
        if remapped.get("ready"):
            payload = {
                "ok": True,
                "code": "OK",
                "message": "服务已就绪",
                "userMessage": "服务已就绪",
                "clientId": cid,
                "bound": True,
                "online": True,
                "ready": True,
                "verified": True,
                "remoteState": REMOTE_STATE_READY,
                "mapping": remapped.get("mapping") or get_mapping(data_dir, cid),
                "meshNodeId": str(remapped.get("meshNodeId") or ""),
                "config": config_snapshot(),
            }
            _live_cache_set(cache_key, payload)
            return payload
        payload = {
            "ok": True,
            "code": str(remapped.get("code") or "MESH_NODE_MISSING"),
            "message": str(remapped.get("message") or "设备映射已失效，正在重新绑定…"),
            "userMessage": str(remapped.get("userMessage") or "正在绑定设备…"),
            "clientId": cid,
            "bound": bool(remapped.get("bound") or node_id),
            "online": bool(remapped.get("online")),
            "ready": False,
            "verified": True,
            "remoteState": str(remapped.get("remoteState") or REMOTE_STATE_UNBOUND),
            "mapping": remapped.get("mapping") or row,
            "meshNodeId": str(remapped.get("meshNodeId") or node_id),
            "config": config_snapshot(),
        }
        _live_cache_set(cache_key, payload)
        return payload

    online = node_is_online(present)
    if not online:
        # Offline mapped node may be a reinstall duplicate — heal onto online agentName match.
        remapped = auto_bind_client(
            data_dir,
            cid,
            owner_username=owner_username,
            userid=userid,
            hostname=hostname,
        )
        if remapped.get("ready"):
            payload = {
                "ok": True,
                "code": "OK",
                "message": "服务已就绪",
                "userMessage": "服务已就绪",
                "clientId": cid,
                "bound": True,
                "online": True,
                "ready": True,
                "verified": True,
                "remoteState": REMOTE_STATE_READY,
                "mapping": remapped.get("mapping") or get_mapping(data_dir, cid),
                "meshNodeId": str(remapped.get("meshNodeId") or ""),
                "config": config_snapshot(),
            }
            _live_cache_set(cache_key, payload)
            return payload

    sync_device_mapping(
        data_dir,
        client_id=cid,
        mesh_node_id=node_id,
        mesh_agent_status="online" if online else "bound",
        mesh_last_seen=_utcnow_iso(),
        owner_username=owner_username,
    )
    mapping = get_mapping(data_dir, cid) or row
    if online:
        payload = {
            "ok": True,
            "code": "OK",
            "message": "服务已就绪",
            "userMessage": "服务已就绪",
            "clientId": cid,
            "bound": True,
            "online": True,
            "ready": True,
            "verified": True,
            "remoteState": REMOTE_STATE_READY,
            "mapping": mapping,
            "meshNodeId": node_id,
            "config": config_snapshot(),
        }
    else:
        payload = {
            "ok": True,
            "code": "MESH_AGENT_OFFLINE",
            "message": "设备当前离线",
            "userMessage": "设备当前离线",
            "clientId": cid,
            "bound": True,
            "online": False,
            "ready": False,
            "verified": True,
            "remoteState": REMOTE_STATE_BOUND_OFFLINE,
            "mapping": mapping,
            "meshNodeId": node_id,
            "config": config_snapshot(),
        }
    _live_cache_set(cache_key, payload)
    return payload


def get_device_status(data_dir: Path, client_id: str, **kwargs: Any) -> dict[str, Any]:
    return resolve_live_device_status(data_dir, client_id, **kwargs)


def _ensure_live_online_node_id(
    data_dir: Path,
    client_id: str,
    *,
    userid: str = "",
    hostname: str = "",
    owner_username: str = "",
) -> tuple[str, Optional[dict[str, Any]]]:
    """
    Shared Desktop/Files session gate:
      validate mapping -> self-heal bind -> confirm agent online.
    Returns (mesh_node_id, failure_payload_or_None).
    """
    clear_live_status_cache()
    status = resolve_live_device_status(
        data_dir,
        client_id,
        userid=userid,
        hostname=hostname,
        owner_username=owner_username,
        force_refresh=True,
    )
    if status.get("ready") and str(status.get("meshNodeId") or "").strip():
        return str(status.get("meshNodeId") or "").strip(), None

    bound = auto_bind_client(
        data_dir,
        client_id,
        owner_username=owner_username,
        userid=userid,
        hostname=hostname,
    )
    if bound.get("ready") and str(bound.get("meshNodeId") or "").strip():
        return str(bound.get("meshNodeId") or "").strip(), None

    code = str(bound.get("code") or status.get("code") or "MESH_PREPARE_FAILED")
    remote_state = str(bound.get("remoteState") or status.get("remoteState") or REMOTE_STATE_ERROR)
    user_message = str(
        bound.get("userMessage")
        or status.get("userMessage")
        or bound.get("message")
        or status.get("message")
        or "远程服务准备失败"
    )
    if code == "MESH_AGENT_OFFLINE" or remote_state == REMOTE_STATE_BOUND_OFFLINE:
        user_message = "正在等待客户端远程服务上线…"
    elif remote_state == REMOTE_STATE_UNVERIFIED:
        user_message = "正在等待设备上线…"
    elif code in ("MESH_NO_MATCH", "MESH_NODE_MISSING", "MESH_PREPARING"):
        user_message = "正在绑定设备…"
    return "", {
        "ok": False,
        "code": code,
        "message": str(bound.get("message") or status.get("message") or user_message),
        "userMessage": user_message,
        "bound": bool(bound.get("bound") or status.get("bound")),
        "online": False,
        "ready": False,
        "verified": bool(bound.get("verified") if "verified" in bound else status.get("verified")),
        "remoteState": remote_state,
        "meshNodeId": str(bound.get("meshNodeId") or status.get("meshNodeId") or ""),
        "mapping": bound.get("mapping") or status.get("mapping"),
    }


_ensure_bound_node_id = _ensure_live_online_node_id


def get_remote_session(
    data_dir: Path,
    client_id: str,
    *,
    userid: str = "",
    hostname: str = "",
    owner_username: str = "",
) -> dict[str, Any]:
    if not is_enabled():
        return {"ok": False, "code": "MESH_DISABLED", "message": "MeshCentral 未启用"}
    node_id, fail = _ensure_live_online_node_id(
        data_dir,
        client_id,
        userid=userid,
        hostname=hostname,
        owner_username=owner_username,
    )
    if fail:
        return fail
    try:
        url = build_embed_url(node_id, VIEWMODE_DESKTOP, userid=userid)
    except Exception as exc:
        return {"ok": False, "code": "MESH_SESSION_ERROR", "message": str(exc)}
    return {
        "ok": True,
        "code": "OK",
        "clientId": client_id,
        "meshNodeId": node_id,
        "viewmode": VIEWMODE_DESKTOP,
        "embedUrl": url,
        "ready": True,
        "online": True,
        "bound": True,
        "verified": True,
        "remoteState": REMOTE_STATE_READY,
        "message": "desktop session ready",
        "userMessage": "服务已就绪",
    }


def get_files_session(
    data_dir: Path,
    client_id: str,
    *,
    userid: str = "",
    hostname: str = "",
    owner_username: str = "",
) -> dict[str, Any]:
    if not is_enabled():
        return {"ok": False, "code": "MESH_DISABLED", "message": "MeshCentral 未启用"}
    node_id, fail = _ensure_live_online_node_id(
        data_dir,
        client_id,
        userid=userid,
        hostname=hostname,
        owner_username=owner_username,
    )
    if fail:
        return fail
    try:
        url = build_embed_url(node_id, VIEWMODE_FILES, userid=userid)
    except Exception as exc:
        return {"ok": False, "code": "MESH_SESSION_ERROR", "message": str(exc)}
    return {
        "ok": True,
        "code": "OK",
        "clientId": client_id,
        "meshNodeId": node_id,
        "viewmode": VIEWMODE_FILES,
        "embedUrl": url,
        "ready": True,
        "online": True,
        "bound": True,
        "verified": True,
        "remoteState": REMOTE_STATE_READY,
        "message": "files session ready",
        "userMessage": "服务已就绪",
    }


# Stable adapter aliases (call sites should prefer these names)
get_device = get_mapping
get_node_by_client_id = get_mapping
bind_device = sync_device_mapping
auto_bind_device = auto_bind_client
create_desktop_session = get_remote_session
create_files_session = get_files_session


def validate_node_ownership(data_dir: Path, client_id: str, mesh_node_id: str) -> bool:
    """True only when the stored mapping for client_id equals mesh_node_id."""
    row = get_mapping(data_dir, client_id)
    if not row:
        return False
    return str(row.get("mesh_node_id") or "").strip() == str(mesh_node_id or "").strip()
