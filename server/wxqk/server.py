#!/usr/bin/env python3
"""微信群控远程管理后台（管理页 /wxqk）：设备注册、远程桌面、会话监控。"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import socket
import threading
import time
from datetime import datetime, timezone, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from wsutil import handshake_response, recv_json, send_frame, send_json
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, unquote, urlparse

try:
    import chat_media as _chat_media
except Exception:  # pragma: no cover
    _chat_media = None  # type: ignore

try:
    from road_archive import RoadArchive, shanghai_day as road_shanghai_day
except Exception:  # pragma: no cover
    RoadArchive = None  # type: ignore
    road_shanghai_day = None  # type: ignore

try:
    from sim_bets import SimBetsStore
except Exception:  # pragma: no cover
    SimBetsStore = None  # type: ignore

try:
    from current_table_store import CurrentTableStore
except Exception:  # pragma: no cover
    CurrentTableStore = None  # type: ignore

try:
    import predictor_ws as _predictor_ws
except Exception:  # pragma: no cover
    _predictor_ws = None  # type: ignore

try:
    import analytics_db as _analytics_db
    from formula_events import (
        aggregate_from_db as _aggregate_formula_from_db,
        aggregate_tables_for_client as _aggregate_tables_for_client,
        finalize_ingest_response as _finalize_formula_ingest_response,
        ingest_formula_events as _ingest_formula_events_db,
        migrate_formula_jsonl as _migrate_formula_jsonl,
    )
    from strict_replay import strict_road_formula_winrate as _strict_road_formula_winrate
except Exception:  # pragma: no cover
    _analytics_db = None  # type: ignore
    _aggregate_formula_from_db = None  # type: ignore
    _aggregate_tables_for_client = None  # type: ignore
    _finalize_formula_ingest_response = None  # type: ignore
    _ingest_formula_events_db = None  # type: ignore
    _migrate_formula_jsonl = None  # type: ignore
    _strict_road_formula_winrate = None  # type: ignore

TZ = timezone(timedelta(hours=8))
def _env(*names: str, default: str = "") -> str:
    for n in names:
        v = os.environ.get(n)
        if v is not None and str(v).strip() != "":
            return str(v)
    return default


PORT = int(_env("WXQK_PORT", "FACAI888_PORT", "SIREN_PORT", default="4812"))
BIND = _env("WXQK_BIND", "FACAI888_BIND", "SIREN_BIND", default="127.0.0.1")
SITE_PASSWORD = str(_env("WXQK_PASSWORD", "FACAI888_PASSWORD", "SIREN_PASSWORD", default="") or "").strip()
UPLOAD_TOKEN = str(_env("WXQK_UPLOAD_TOKEN", "FACAI888_UPLOAD_TOKEN", "SIREN_UPLOAD_TOKEN", default="") or "").strip()
TOKEN_SECRET = hashlib.sha256((SITE_PASSWORD + "|wxqk-v1").encode()).digest() if SITE_PASSWORD else b""


def _parse_admin_token_ttl() -> int:
    """Admin session TTL seconds. Env FACAI888_TOKEN_TTL / SIREN_TOKEN_TTL; default 24h."""
    raw = str(_env("FACAI888_TOKEN_TTL", "SIREN_TOKEN_TTL", default="") or "").strip()
    if raw:
        try:
            n = int(raw)
            # Floor 5 minutes so misconfig cannot instantly thrash logins.
            if n >= 300:
                return n
        except ValueError:
            pass
    return 24 * 3600


TOKEN_TTL = _parse_admin_token_ttl()
ONLINE_TTL = 90  # seconds
DATA_DIR = Path(_env("WXQK_DATA", "FACAI888_DATA", "SIREN_DATA", default="/opt/wxqk/data"))
PUBLIC_BASE_URL = str(
    _env("FACAI888_PUBLIC_BASE_URL", "WXQK_PUBLIC_BASE_URL", default="https://120.27.219.138:8443/wxqk") or ""
).strip().rstrip("/") or "https://120.27.219.138:8443/wxqk"
_TRUSTED_PROXIES_RAW = str(_env("FACAI888_TRUSTED_PROXIES", "SIREN_TRUSTED_PROXIES", default="127.0.0.1,::1"))
LOG_DIR = DATA_DIR / "logs"
META_DIR = DATA_DIR / "clients"
SHOT_DIR = DATA_DIR / "shots"
CMD_DIR = DATA_DIR / "commands"
ANNOUNCE_DIR = DATA_DIR / "announces"
FORMULA_DIR = DATA_DIR / "formula"
FORMULA_EVENTS = FORMULA_DIR / "events.jsonl"
ROAD_DIR = DATA_DIR / "roads"
SIM_BETS_DIR = DATA_DIR / "sim-bets"
CURRENT_TABLE_DIR = DATA_DIR / "current-tables"
WX_SYNC_DIR = DATA_DIR / "wx-sync"
FRIEND_DIAG_DIR = DATA_DIR / "friend-diagnostics"
ANNOUNCE_TTL = 24 * 3600  # seconds — pending IP announce lifetime

_road_archive = RoadArchive(ROAD_DIR) if RoadArchive else None
_sim_bets = SimBetsStore(SIM_BETS_DIR) if SimBetsStore else None
_current_tables = CurrentTableStore(CURRENT_TABLE_DIR) if CurrentTableStore else None

_FORMULA_PLACE_CODES = frozenset({"PLACE_OK", "PLACE_BLOCKED", "PLACE_FAILED"})
_FORMULA_SETTLE_CODES = frozenset({"SETTLE_OK", "SETTLE_UNKNOWN"})
_FORMULA_KEEP_KEYS = (
    "code",
    "patternHash",
    "patternText",
    "slot",
    "simulated",
    "gameResult",
    "betTransactionId",
    "betAmount",
    "betSide",
    "tableId",
    "tableTitle",
    "roundId",
)

_lock = threading.RLock()  # online / shot-meta (legacy name kept for patches)
_online_lock = _lock
_formula_lock = threading.RLock()
_shot_lock = threading.RLock()
_policy_lock = threading.RLock()
_online: dict[str, dict[str, Any]] = {}  # client_id -> meta
_latest_shot: dict[str, dict[str, Any]] = {}  # client_id -> {ts, t}
_latest_shot_image: dict[str, str] = {}  # client_id -> normalized data-URI (memory)
_shot_last_disk_at: dict[str, float] = {}
_shot_disk_writes = 0
_normalize_calls = 0
_online_persist_at: dict[str, float] = {}
_online_persist_fp: dict[str, str] = {}
_online_disk_writes = 0
MAX_FRAME_B64_CHARS = 3_500_000
MAX_DELTA_TILES = 800
MAX_DELTA_TILE_B64_CHARS = 400_000
SHOT_DISK_INTERVAL_SEC = 10.0
ONLINE_PERSIST_INTERVAL_SEC = 60.0

# --- runtime policy cache ---
_policy_cache: dict[str, Any] | None = None
_policy_mtime: float | None = None
_policy_load_count = 0

# --- known IP list cache ---
_known_ips_cache: list[dict[str, Any]] | None = None
_known_ips_cache_at = 0.0
_known_ips_scan_count = 0
KNOWN_IPS_CACHE_TTL = 5.0

# --- formula rotate throttle ---
try:
    from text_rotate import ThrottledRotator
except Exception:  # pragma: no cover
    ThrottledRotator = None  # type: ignore

_formula_rotator = (
    ThrottledRotator(
        trigger_bytes=64 * 1024 * 1024,
        target_bytes=28 * 1024 * 1024,  # mid of 24–32MB
        interval_sec=60.0,
        event_threshold=400,
    )
    if ThrottledRotator
    else None
)
_ip_log_rotator = (
    ThrottledRotator(
        trigger_bytes=32 * 1024 * 1024,
        target_bytes=16 * 1024 * 1024,
        interval_sec=60.0,
        event_threshold=200,
    )
    if ThrottledRotator
    else None
)
_friend_diag_rotator = (
    ThrottledRotator(
        trigger_bytes=40 * 1024 * 1024,
        target_bytes=20 * 1024 * 1024,
        interval_sec=120.0,
        event_threshold=100,
    )
    if ThrottledRotator
    else None
)

# --- realtime desktop WS hubs ---
_agent_ws: dict[str, Any] = {}   # clientId -> socket
_viewer_ws: dict[str, list] = {}  # clientId -> [sockets]
# viewer socket -> desktopSessionId（WebRTC 信令按会话隔离，避免多路抢 answer）
_viewer_desktop_session: dict[int, str] = {}
# viewer socket -> bound LiveKit session：跳过 JPEG/delta 扇出
_viewer_skip_jpeg: dict[int, float] = {}
_ws_lock = threading.RLock()
_viewer_tickets: dict[str, dict[str, Any]] = {}


def make_viewer_ticket(client_id: str) -> str:
    ticket = secrets.token_urlsafe(32)
    now = now_ts()
    with _ws_lock:
        for key, row in list(_viewer_tickets.items()):
            if float(row.get("expiresAt") or 0) < now:
                _viewer_tickets.pop(key, None)
        _viewer_tickets[ticket] = {"clientId": safe_id(client_id), "expiresAt": now + 30}
    return ticket


def consume_viewer_ticket(ticket: str, client_id: str) -> bool:
    with _ws_lock:
        row = _viewer_tickets.pop(str(ticket or ""), None)
    return bool(row and float(row.get("expiresAt") or 0) >= now_ts() and row.get("clientId") == safe_id(client_id))


def register_agent(cid: str, sock) -> None:
    cid = safe_id(cid)
    with _ws_lock:
        old = _agent_ws.get(cid)
        _agent_ws[cid] = sock
    if old and old is not sock:
        try:
            old.close()
        except Exception:
            pass


def unregister_agent(cid: str, sock) -> None:
    cid = safe_id(cid)
    with _ws_lock:
        if _agent_ws.get(cid) is sock:
            _agent_ws.pop(cid, None)


def register_viewer(cid: str, sock) -> None:
    cid = safe_id(cid)
    with _ws_lock:
        _viewer_ws.setdefault(cid, []).append(sock)


def unregister_viewer(cid: str, sock) -> None:
    cid = safe_id(cid)
    with _ws_lock:
        arr = _viewer_ws.get(cid) or []
        _viewer_ws[cid] = [s for s in arr if s is not sock]
        if not _viewer_ws[cid]:
            _viewer_ws.pop(cid, None)
        _viewer_desktop_session.pop(id(sock), None)
        _viewer_skip_jpeg.pop(id(sock), None)


def bind_viewer_desktop_session(sock, session_id: str) -> None:
    """Associate a viewer WS with a WebRTC desktopSessionId for signaling fan-out."""
    sid = str(session_id or "").strip()
    if not sock:
        return
    with _ws_lock:
        if sid:
            _viewer_desktop_session[id(sock)] = sid
            # LiveKit 会话：观众走媒体面，勿再灌 JPEG/delta（省上行×观众数）
            try:
                import webrtc_session as wrs

                sess = wrs.get_session(sid) or {}
                if str(sess.get("transport") or "") == "livekit":
                    _viewer_skip_jpeg[id(sock)] = time.time()
                else:
                    _viewer_skip_jpeg.pop(id(sock), None)
            except Exception:
                _viewer_skip_jpeg.pop(id(sock), None)
        else:
            _viewer_desktop_session.pop(id(sock), None)
            _viewer_skip_jpeg.pop(id(sock), None)


def viewer_desktop_session(sock) -> str:
    with _ws_lock:
        return str(_viewer_desktop_session.get(id(sock), "") or "")


def save_wx_sync(client_id: str, payload: dict[str, Any]) -> None:
    cid = safe_id(client_id)
    if not cid or cid == "unknown" or not isinstance(payload, dict):
        return
    allowed = {}
    limits = {"instances": 200, "contacts": 20000, "groups": 5000, "members": 50000, "tasks": 500, "taskItems": 500, "logs": 500}
    for key, limit in limits.items():
        rows = payload.get(key)
        selected = [row for row in rows[:limit] if isinstance(row, dict)] if isinstance(rows, list) else []
        if key == "taskItems":
            item_keys = (
                "itemId", "taskId", "taskName", "taskType", "taskStatus", "instanceId",
                "targetKey", "actionType", "status", "error", "startedAt", "finishedAt",
            )
            selected = [{field: row[field] for field in item_keys if field in row} for row in selected]
        if key == "logs":
            log_keys = (
                "time", "level", "instanceId", "module", "message", "reason", "operation",
                "taskId", "sourceId", "path", "status", "durationMs", "code", "businessCode",
                "result",
                "targetWxid", "accountWxid", "senderWxid", "roomId", "missing", "attempts",
                "endpoint", "httpStatus", "baseRet", "contactCount", "contactListLength",
                "matchedContact", "matchedTicket", "hasV3", "v3Prefix", "v3Length",
                "hasV4", "v4Prefix", "v4Length", "attempt", "elapsedMs", "nextAction",
                "parserVersion", "sourceRoomId", "sourceRoomName", "sourceInstanceId",
                "sourceInstancePort", "instancePort", "requestUrl", "requestBodyWxid",
                "requestBodyRoomId", "rawType", "rawTopLevelKeys", "dataType",
                "dataTopLevelKeys", "bodyLength", "rawPreview",
                "diagnosticId", "clientVersion", "wechatVersion", "dllPath", "dllSha256",
                "matchedIdentity", "matchedContactBy", "matchedTicketBy", "identityMatched",
                "finalClassification", "credentialSource", "requestBodyKeys", "requestWxid",
                "injectionFailed", "succeeded", "failed", "output", "error", "apiPort", "tcpPort", "pid",
            )
            selected = [{field: row[field] for field in log_keys if field in row} for row in selected]
        allowed[key] = selected
    allowed["capturedAt"] = str(payload.get("capturedAt") or now_iso())[:40]
    WX_SYNC_DIR.mkdir(parents=True, exist_ok=True)
    target = WX_SYNC_DIR / f"{cid}.json"
    temp = WX_SYNC_DIR / f".{cid}.{secrets.token_hex(4)}.tmp"
    temp.write_text(json.dumps(allowed, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    os.replace(temp, target)


def list_wx_sync() -> list[dict[str, Any]]:
    rows = []
    if not WX_SYNC_DIR.exists():
        return rows
    for path in WX_SYNC_DIR.glob("*.json"):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                rows.append({"clientId": path.stem, **data})
        except Exception:
            continue
    return rows


def _redact_friend_diagnostic_value(value: Any) -> Any:
    """Recursively redact strings that may contain credentials or secrets."""
    if isinstance(value, dict):
        return {k: _redact_friend_diagnostic_value(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_redact_friend_diagnostic_value(v) for v in value]
    if isinstance(value, str):
        lower = value.lower()
        if (
            "v3_" in lower
            or "v4_" in lower
            or "bearer " in lower
            or "authorization" in lower
            or "token" in lower
            or "cookie" in lower
            or "secret" in lower
        ):
            return "[REDACTED]"
        return value
    return value


def prune_friend_diagnostics(*, max_files: int = 1000, retention_days: float = 30) -> dict[str, int]:
    """Remove old friend diagnostic JSON files; keep at most max_files newest."""
    removed = 0
    if not FRIEND_DIAG_DIR.exists():
        return {"removed": 0}
    cutoff = now_ts() - float(retention_days) * 86400.0
    files = sorted(
        (p for p in FRIEND_DIAG_DIR.glob("*.json") if p.is_file()),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    keep = set(files[: max(0, int(max_files))])
    for path in files:
        try:
            mtime = path.stat().st_mtime
        except OSError:
            continue
        if path in keep and mtime >= cutoff:
            continue
        try:
            path.unlink(missing_ok=True)
            removed += 1
        except OSError:
            pass
    index_path = FRIEND_DIAG_DIR / "index.jsonl"
    if _friend_diag_rotator is not None:
        _friend_diag_rotator.maybe_rotate(index_path)
    elif index_path.exists():
        try:
            from text_rotate import rotate_keep_tail_bytes
            rotate_keep_tail_bytes(
                index_path,
                trigger_bytes=40 * 1024 * 1024,
                target_bytes=20 * 1024 * 1024,
            )
        except Exception:
            pass
    return {"removed": removed}


def save_friend_diagnostic(report: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(report, dict):
        return {"ok": False, "message": "bad_report"}
    diagnostic_id = str(report.get("diagnosticId") or secrets.token_hex(8)).strip()
    client_id = safe_id(report.get("clientId") or "")
    cleaned = _redact_friend_diagnostic_value(dict(report))
    for key in ("v3", "v4", "_v3", "_v4", "_keepV3", "_keepV4"):
        if isinstance(cleaned, dict):
            cleaned.pop(key, None)
    probes = cleaned.get("probes") if isinstance(cleaned, dict) else None
    if isinstance(probes, list):
        safe_probes = []
        for probe in probes:
            if not isinstance(probe, dict):
                continue
            row = {k: v for k, v in probe.items() if not str(k).startswith("_") and k not in ("v3", "v4")}
            if "rawPreview" in row:
                row["rawPreview"] = str(row.get("rawPreview") or "")[:5000]
            safe_probes.append(row)
        cleaned["probes"] = safe_probes
    cleaned["diagnosticId"] = diagnostic_id
    cleaned["clientId"] = client_id
    cleaned["savedAt"] = now_iso()
    FRIEND_DIAG_DIR.mkdir(parents=True, exist_ok=True)
    path = FRIEND_DIAG_DIR / f"{diagnostic_id}.json"
    path.write_text(json.dumps(cleaned, ensure_ascii=False, indent=2), encoding="utf-8")
    index_path = FRIEND_DIAG_DIR / "index.jsonl"
    with index_path.open("a", encoding="utf-8") as f:
        f.write(json.dumps({
            "t": cleaned["savedAt"],
            "diagnosticId": diagnostic_id,
            "clientId": client_id,
            "finalClassification": cleaned.get("finalClassification"),
            "credentialSource": cleaned.get("credentialSource"),
            "accountWxid": cleaned.get("accountWxid"),
            "targetUserName": cleaned.get("targetUserName"),
        }, ensure_ascii=False, separators=(",", ":")) + "\n")
    if _friend_diag_rotator is not None:
        _friend_diag_rotator.note_append()
        _friend_diag_rotator.maybe_rotate(index_path)
    try:
        prune_friend_diagnostics()
    except Exception:
        pass
    return {"ok": True, "diagnosticId": diagnostic_id}


def load_friend_diagnostic(diagnostic_id: str) -> dict[str, Any] | None:
    did = "".join(ch for ch in str(diagnostic_id or "") if ch.isalnum() or ch in "-_")[:80]
    if not did:
        return None
    path = FRIEND_DIAG_DIR / f"{did}.json"
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else None
    except Exception:
        return None


def viewer_count(cid: str) -> int:
    cid = safe_id(cid)
    with _ws_lock:
        return len(_viewer_ws.get(cid) or [])


# Cap START/STOP thrash from multi-viewer reconnect + stale kicks (works without client upgrade).
# forceRestart still must reach the agent periodically — soft coalesce must not swallow it entirely
# (1.62 agent ignores soft start_desktop while captureTimer is already running).
# LiveKit 房间按设备固定：墙侧每 15~30s 新 sid 若都 force，会 DUPLICATE_IDENTITY / getDisplayMedia 风暴。
_DESKTOP_FORCE_RESTART_MIN_SEC = 90.0
_DESKTOP_SOFT_START_COALESCE_SEC = 12.0
# 旧客户端(≤1.74)收到任何 start_desktop 都会 leave+重进 LiveKit；LiveKit 路径尽量少下发
_DESKTOP_LIVEKIT_START_COALESCE_SEC = 120.0
# last forced sessionId per client — new WebRTC session must always hard-kick
_desktop_start_meta: dict[str, dict[str, float | str]] = {}
_desktop_start_lock = threading.Lock()


def start_desktop_for_agent(
    cid: str,
    *,
    quality: str = "auto",
    session_id: str = "",
    force_restart: bool = False,
    ice_servers: list | None = None,
    protocol_version: str = "",
    control_mouse: bool = True,
    control_keyboard: bool = True,
    livekit_url: str = "",
    livekit_token: str = "",
    room_name: str = "",
) -> bool:
    """Tell agent to start continuous desktop; always queue fallback for WS miss."""
    cid = safe_id(cid)
    if not cid or cid == "unknown":
        return False
    now = time.time()
    with _desktop_start_lock:
        meta = _desktop_start_meta.setdefault(
            cid,
            {
                "last_soft": 0.0,
                "last_force": 0.0,
                "last_session_id": "",
                "last_room": "",
                "last_livekit_token": "",
            },
        )
        prev_room = str(meta.get("last_room") or "")
        same_room = bool(room_name and prev_room and room_name == prev_room)
        has_livekit = bool(livekit_url and livekit_token)
        token_changed = bool(
            livekit_token and livekit_token != str(meta.get("last_livekit_token") or "")
        )
        with _online_lock:
            already = bool((_online.get(cid) or {}).get("desktopWatching"))
        since_soft = now - float(meta.get("last_soft") or 0.0)
        since_force = now - float(meta.get("last_force") or 0.0)
        demoted = False
        if force_restart:
            # 同房/已在看：90s 内禁止硬拉（旧客户端硬拉=拆采集）
            if since_force < _DESKTOP_FORCE_RESTART_MIN_SEC and (same_room or already or has_livekit):
                force_restart = False
                demoted = True
            else:
                meta["last_force"] = now
        if session_id:
            meta["last_session_id"] = session_id
        if room_name:
            meta["last_room"] = room_name
        # LiveKit：同房软续命长窗口吞掉；token 轮换限流软发（避免每秒新 sid 打穿 coalesce）
        if (
            has_livekit
            and not force_restart
            and since_soft < _DESKTOP_LIVEKIT_START_COALESCE_SEC
            and (already or same_room)
        ):
            if not token_changed:
                return True
            # 被墙侧踢降级后至少再软发一次，否则冻屏代理永远收不到令
            if demoted:
                pass
            elif since_soft < 25.0:
                return True
        if not force_restart:
            if already and not session_id and since_soft < _DESKTOP_SOFT_START_COALESCE_SEC:
                return True
        meta["last_soft"] = now
        if livekit_token:
            meta["last_livekit_token"] = str(livekit_token)
    payload: dict[str, Any] = {
        "type": "start_desktop",
        "continuous": True,
        "quality": quality or "auto",
        # Viewer watch / reconnect must not wipe remote input permissions.
        "controlMouse": bool(control_mouse),
        "controlKeyboard": bool(control_keyboard),
    }
    if session_id:
        payload["desktopSessionId"] = session_id
    if protocol_version:
        payload["protocolVersion"] = protocol_version
    if ice_servers:
        payload["iceServers"] = ice_servers
    if livekit_url and livekit_token:
        payload["transport"] = "livekit"
        payload["livekitUrl"] = livekit_url
        payload["livekitToken"] = livekit_token
        if room_name:
            payload["roomName"] = room_name
    if force_restart:
        payload["forceRestart"] = True
        payload["kick"] = True
    ok = tell_agent(cid, payload)
    try:
        ice_n = len(ice_servers or [])
        line = (
            f"[webrtc] start_desktop cid={cid[:12]} sid={str(session_id or '')[:16]} "
            f"force={int(bool(force_restart))} ice={ice_n} livekit={int(bool(livekit_url and livekit_token))} "
            f"ws={int(bool(ok))}\n"
        )
        print(line, end="", flush=True)
        (LOG_DIR / "webrtc.log").parent.mkdir(parents=True, exist_ok=True)
        with open(LOG_DIR / "webrtc.log", "a", encoding="utf-8") as wf:
            wf.write(line)
    except Exception:
        pass
    # WS 已送达则不再入队：旧端 hello/重连再吃一遍 START_DESKTOP 会拆 LiveKit。
    # 仅 WS 失败时排队，覆盖短暂断线。
    if not ok:
        queued = {
            "type": "start_desktop",
            "continuous": True,
            "quality": quality or "auto",
            "controlMouse": bool(control_mouse),
            "controlKeyboard": bool(control_keyboard),
        }
        if session_id:
            queued["desktopSessionId"] = session_id
        if protocol_version:
            queued["protocolVersion"] = protocol_version
        if ice_servers:
            queued["iceServers"] = ice_servers
        if livekit_url and livekit_token:
            queued["transport"] = "livekit"
            queued["livekitUrl"] = livekit_url
            queued["livekitToken"] = livekit_token
            if room_name:
                queued["roomName"] = room_name
        if force_restart:
            queued["forceRestart"] = True
            queued["kick"] = True
        set_command(cid, queued)
    with _online_lock:
        if cid in _online:
            _online[cid]["desktopWatching"] = True
    return ok


def resume_desktop_if_viewers(cid: str) -> None:
    """After agent hello/reconnect: if admin is still watching, restart capture."""
    cid = safe_id(cid)
    if not cid or cid == "unknown":
        return
    if viewer_count(cid) <= 0:
        return
    # 有观众时只等带 LiveKit 凭证的 watch；无 sid / 无 token 的软拉只会刷 JPEG 噪声。
    # （旧逻辑空 sid start_desktop 会在日志里刷 livekit=0，并与真正会话打架。）
    return


_stop_desktop_timers: dict[str, threading.Timer] = {}
_stop_desktop_lock = threading.Lock()


def schedule_stop_desktop_if_idle(cid: str, delay_sec: float = 2.0) -> None:
    """Debounce stop so brief viewer reconnect does not kill the publisher."""
    cid = safe_id(cid)
    if not cid or cid == "unknown":
        return

    def _fire() -> None:
        with _stop_desktop_lock:
            _stop_desktop_timers.pop(cid, None)
        if viewer_count(cid) > 0:
            return
        tell_agent(cid, {"type": "stop_desktop"})
        set_command(cid, {"type": "stop_desktop"})
        with _desktop_start_lock:
            _desktop_start_meta.pop(cid, None)
        with _online_lock:
            if cid in _online:
                _online[cid]["desktopWatching"] = False

    with _stop_desktop_lock:
        old = _stop_desktop_timers.pop(cid, None)
        if old is not None:
            try:
                old.cancel()
            except Exception:
                pass
        t = threading.Timer(max(0.5, float(delay_sec)), _fire)
        t.daemon = True
        _stop_desktop_timers[cid] = t
        t.start()


def cancel_pending_stop_desktop(cid: str) -> None:
    cid = safe_id(cid)
    with _stop_desktop_lock:
        old = _stop_desktop_timers.pop(cid, None)
    if old is not None:
        try:
            old.cancel()
        except Exception:
            pass


def push_to_viewers(cid: str, obj: dict) -> None:
    cid = safe_id(cid)
    with _ws_lock:
        viewers = list(_viewer_ws.get(cid) or [])
        session_map = dict(_viewer_desktop_session)
        skip_jpeg = dict(_viewer_skip_jpeg)
    typ = str((obj or {}).get("type") or "")
    sid = str((obj or {}).get("desktopSessionId") or "").strip()
    # WebRTC 信令按会话隔离：
    # - 有 sid：发给「同 sid」或「尚未绑定」的 viewer（未绑定常见于 session 刚建、watch 尚未到达）
    # - 无 sid：只给未绑定 viewer，避免串到其它会话
    webrtc_signal = typ.startswith("webrtc_")
    jpeg_like = typ in ("frame", "frame_delta")
    dead = []
    for s in viewers:
        if jpeg_like and id(s) in skip_jpeg:
            continue
        if webrtc_signal:
            viewer_sid = str(session_map.get(id(s), "") or "")
            if sid:
                if viewer_sid and viewer_sid != sid:
                    continue
            elif viewer_sid:
                # 代理旧包无 sessionId：勿打给已绑定其它会话的 viewer
                continue
        try:
            send_json(s, obj)
        except Exception:
            dead.append(s)
    for s in dead:
        unregister_viewer(cid, s)


def notify_predictors(event_type: str, payload: dict[str, Any] | None = None, **extra: Any) -> None:
    """Push table sync events to predictor WS subscribers (best-effort)."""
    if _predictor_ws is None or not payload:
        return
    try:
        msg = {
            "type": event_type,
            "t": now_iso(),
            **{k: v for k, v in (payload or {}).items() if k not in ("type",)},
            **extra,
        }
        _predictor_ws.push_to_predictors(msg, send_json=send_json)
    except Exception:
        pass


def tell_agent(cid: str, obj: dict) -> bool:
    cid = safe_id(cid)
    with _ws_lock:
        sock = _agent_ws.get(cid)
    if not sock:
        return False
    try:
        send_json(sock, obj)
        return True
    except Exception:
        unregister_agent(cid, sock)
        return False



def now_ts() -> float:
    return time.time()


def now_iso() -> str:
    return datetime.now(TZ).strftime("%Y-%m-%d %H:%M:%S")


_LOG_FULL_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2}):(\d{2})")
_LOG_HMS_RE = re.compile(r"^(\d{1,2}):(\d{2}):(\d{2})$")


def normalize_log_time(raw: Any, *, iso_ts: str = "", fallback_date: str = "") -> str:
    """Unify log timestamps to 'YYYY-MM-DD HH:MM:SS' (Asia/Shanghai when converted)."""
    s = str(raw or "").strip()
    m = _LOG_FULL_RE.match(s)
    if m:
        return f"{m.group(1)} {m.group(2)}:{m.group(3)}:{m.group(4)}"
    iso = str(iso_ts or "").strip()
    if iso:
        try:
            dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=TZ)
            return dt.astimezone(TZ).strftime("%Y-%m-%d %H:%M:%S")
        except Exception:
            pass
    hm = _LOG_HMS_RE.match(s)
    if hm:
        day = str(fallback_date or "").strip()
        if not _LOG_FULL_RE.match(day + " 00:00:00"):
            day = datetime.now(TZ).strftime("%Y-%m-%d")
        else:
            day = day[:10]
        return f"{day} {int(hm.group(1)):02d}:{hm.group(2)}:{hm.group(3)}"
    if not s:
        return now_iso()
    return s[:32]


def ensure_dirs() -> None:
    for p in (
        DATA_DIR, LOG_DIR, META_DIR, SHOT_DIR, CMD_DIR, ANNOUNCE_DIR,
        FORMULA_DIR, ROAD_DIR, SIM_BETS_DIR, CURRENT_TABLE_DIR,
        DATA_DIR / "media", WX_SYNC_DIR, FRIEND_DIAG_DIR,
    ):
        p.mkdir(parents=True, exist_ok=True)
    if _chat_media is not None:
        try:
            _chat_media.init_db(DATA_DIR)
        except Exception as e:
            print(f"[wxqk] chat_media init failed: {e}", flush=True)
    if _analytics_db is not None:
        try:
            _analytics_db.configure(DATA_DIR)
            _analytics_db.get_conn()  # init schema once
        except Exception as e:
            print(f"[analytics] db init failed: {e}", flush=True)
    try:
        import security_db as _security_db
        _security_db.configure(DATA_DIR)
    except Exception as e:
        print(f"[security] db init failed: {e}", flush=True)


def init_analytics_migrate() -> None:
    """Best-effort one-shot migrations; never abort server boot."""
    if _analytics_db is None:
        return
    try:
        ensure_dirs()
        if _migrate_formula_jsonl is not None:
            r = _migrate_formula_jsonl(FORMULA_EVENTS)
            print(f"[analytics] formula jsonl migrate: {r}", flush=True)
        if _road_archive is not None and hasattr(_road_archive, "migrate_roads_to_sqlite"):
            r2 = _road_archive.migrate_roads_to_sqlite()
            print(f"[analytics] roads migrate: {r2}", flush=True)
    except Exception as e:
        print(f"[analytics] migrate error (non-fatal): {e}", flush=True)


def make_admin_token() -> str:
    exp = int(now_ts()) + TOKEN_TTL
    nonce = secrets.token_hex(8)
    raw = f"{exp}.{nonce}"
    sig = hmac.new(TOKEN_SECRET, raw.encode(), hashlib.sha256).hexdigest()[:32]
    return f"{raw}.{sig}"


def admin_token_exp(token: str) -> int:
    parts = str(token or "").split(".")
    if len(parts) != 3:
        return 0
    try:
        return int(parts[0])
    except ValueError:
        return 0


def check_admin_token(token: str) -> bool:
    parts = str(token or "").split(".")
    if len(parts) != 3:
        return False
    exp_s, nonce, sig = parts
    try:
        exp = int(exp_s)
    except ValueError:
        return False
    if exp < int(now_ts()):
        return False
    raw = f"{exp_s}.{nonce}"
    expect = hmac.new(TOKEN_SECRET, raw.encode(), hashlib.sha256).hexdigest()[:32]
    return hmac.compare_digest(expect, sig)


def maybe_renew_admin_token(token: str) -> str:
    """Sliding renew while admin UI is active — avoid hard 登录掉线 mid-session."""
    if not check_admin_token(token):
        return ""
    remain = admin_token_exp(token) - int(now_ts())
    # Renew once past half-life so an open dashboard never hits absolute expiry.
    if remain <= max(300, TOKEN_TTL // 2):
        return make_admin_token()
    return ""


def safe_ip(ip: str) -> str:
    s = re.sub(r"[^0-9a-fA-F:\.]", "_", str(ip or "").strip()) or "unknown"
    return s[:64]


def safe_id(cid: str) -> str:
    s = re.sub(r"[^0-9a-zA-Z_\-]", "_", str(cid or "").strip()) or "unknown"
    return s[:80]


def tail_text_lines(path: Path, max_lines: int, max_read_bytes: int = 8_000_000) -> list[str]:
    """Read last max_lines of a text file without loading the whole file into RAM."""
    want = max(1, int(max_lines or 1))
    cap = max(64_000, int(max_read_bytes or 64_000))
    try:
        size = path.stat().st_size
    except OSError:
        return []
    if size <= 0:
        return []
    try:
        with path.open("rb") as f:
            if size <= cap:
                raw = f.read()
            else:
                f.seek(max(0, size - cap))
                raw = f.read()
        text = raw.decode("utf-8", errors="replace")
        # Drop partial first line when we seek mid-file.
        if size > cap and "\n" in text:
            text = text.split("\n", 1)[1]
        lines = text.splitlines()
        if len(lines) > want:
            lines = lines[-want:]
        return lines
    except OSError:
        return []


def _rotate_text_file_keep_tail(path: Path, max_bytes: int, keep_lines: int) -> None:
    """Legacy line-based rotate (IP logs). Prefer ThrottledRotator for formula."""
    try:
        if not path.exists() or path.stat().st_size < max_bytes:
            return
        # Target ~half trigger to avoid immediate re-trigger.
        target = max(max_bytes // 2, 1_000_000)
        if ThrottledRotator:
            from text_rotate import rotate_keep_tail_bytes
            rotate_keep_tail_bytes(path, trigger_bytes=max_bytes, target_bytes=target)
            return
        lines = tail_text_lines(path, keep_lines, max_read_bytes=max(max_bytes, 8_000_000))
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_text(("\n".join(lines) + "\n") if lines else "", encoding="utf-8")
        tmp.replace(path)
    except Exception:
        pass


def trusted_proxy_set() -> set[str]:
    out: set[str] = set()
    for part in _TRUSTED_PROXIES_RAW.split(","):
        tip = safe_ip(part.strip())
        if tip and tip != "unknown":
            out.add(tip)
    if not out:
        out.update({"127.0.0.1", "::1"})
    return out


def client_ip(handler: BaseHTTPRequestHandler) -> str:
    """Only honor XFF/X-Real-IP when the direct peer is a trusted reverse proxy."""
    peer = safe_ip(handler.client_address[0])
    if peer in trusted_proxy_set():
        xff = handler.headers.get("X-Forwarded-For") or handler.headers.get("X-Real-IP") or ""
        if xff:
            return safe_ip(xff.split(",")[0].strip())
    return peer


def _as_bool(v: Any) -> bool:
    if v is True:
        return True
    if v is False or v is None:
        return False
    return str(v).strip().lower() in ("1", "true", "yes")


def _formula_label(row: dict[str, Any]) -> str:
    text = str(row.get("patternText") or "").strip()
    if text:
        return text[:120]
    return str(row.get("patternHash") or "").strip()[:120]


def invalidate_known_ips_cache() -> None:
    global _known_ips_cache, _known_ips_cache_at
    _known_ips_cache = None
    _known_ips_cache_at = 0.0


def append_log(ip: str, rows: list[dict[str, Any]]) -> int:
    path = LOG_DIR / f"{safe_ip(ip)}.jsonl"
    n = 0
    formula_rows: list[tuple[dict[str, Any], dict[str, Any]]] = []
    with _online_lock:
        with path.open("a", encoding="utf-8") as f:
            for row in rows:
                if not isinstance(row, dict):
                    continue
                text = str(row.get("text") or row.get("message") or "").strip()
                if not text:
                    continue
                line: dict[str, Any] = {
                    "t": normalize_log_time(
                        row.get("t") or row.get("localTime"),
                        iso_ts=str(row.get("timestamp") or row.get("occurredAt") or ""),
                    ),
                    "text": text[:500],
                    "kind": str(row.get("kind") or "操作")[:20],
                    "clientId": str(row.get("clientId") or "")[:80],
                }
                for key in _FORMULA_KEEP_KEYS:
                    if key not in row:
                        continue
                    val = row.get(key)
                    if val is None or val == "":
                        continue
                    if key == "simulated":
                        line[key] = val is True or str(val).lower() in ("1", "true", "yes")
                    elif key in ("slot", "tableId", "roundId", "betAmount"):
                        try:
                            line[key] = int(val) if key != "betAmount" else int(float(val))
                        except Exception:
                            continue
                    else:
                        line[key] = str(val)[:200]
                f.write(json.dumps(line, ensure_ascii=False) + "\n")
                n += 1
                formula_rows.append((row, line))
        if _ip_log_rotator:
            _ip_log_rotator.note_append(n)
            _ip_log_rotator.maybe_rotate(path)
        else:
            _rotate_text_file_keep_tail(path, max_bytes=32 * 1024 * 1024, keep_lines=20_000)
    if formula_rows:
        _append_formula_events(ip, formula_rows)
        invalidate_known_ips_cache()
    elif n:
        invalidate_known_ips_cache()
    return n


def _append_formula_events(ip: str, pairs: list[tuple[dict[str, Any], dict[str, Any]]]) -> None:
    """Append formula events under dedicated lock; rotate outside online lock."""
    written = 0
    db_events: list[dict[str, Any]] = []
    with _formula_lock:
        try:
            ensure_dirs()
            with FORMULA_EVENTS.open("a", encoding="utf-8") as f:
                for raw, line in pairs:
                    ev = _build_formula_event(ip, raw, line)
                    if not ev:
                        continue
                    f.write(json.dumps(ev, ensure_ascii=False) + "\n")
                    written += 1
                    db_events.append(_formula_event_to_db_row(ev, raw))
        except Exception:
            return
        if written and _formula_rotator:
            _formula_rotator.note_append(written)
            _formula_rotator.maybe_rotate(FORMULA_EVENTS)
        elif written:
            _rotate_text_file_keep_tail(FORMULA_EVENTS, max_bytes=64 * 1024 * 1024, keep_lines=200_000)
    if db_events and _ingest_formula_events_db is not None:
        try:
            _ingest_formula_events_db(db_events, ip=ip, source="live")
        except Exception:
            pass


def _formula_event_to_db_row(ev: dict[str, Any], raw: dict[str, Any] | None = None) -> dict[str, Any]:
    raw = raw or {}
    code = str(ev.get("code") or "").upper()
    return {
        "code": code,
        "clientId": ev.get("clientId"),
        "accountHash": raw.get("accountHash") or ev.get("accountHash"),
        "maskedAccount": raw.get("maskedAccount") or raw.get("account") or "",
        "ip": ev.get("ip"),
        "formulaId": ev.get("formula") or ev.get("patternHash") or ev.get("patternText"),
        "patternText": ev.get("patternText"),
        "patternHash": ev.get("patternHash"),
        "slot": ev.get("slot"),
        "simulated": ev.get("simulated"),
        "betTransactionId": ev.get("betTransactionId"),
        "gameResult": ev.get("gameResult"),
        "betAmount": ev.get("betAmount"),
        "betSide": ev.get("betSide"),
        "tableId": ev.get("tableId"),
        "tableTitle": ev.get("tableTitle"),
        "bootNo": raw.get("bootNo") or raw.get("boot"),
        "roundId": raw.get("roundId"),
        "netProfit": raw.get("netProfit"),
        "settlementSource": raw.get("settlementSource"),
        "settlementConfidence": raw.get("settlementConfidence") or "CONFIRMED",
        "unknownReason": raw.get("unknownReason"),
        "occurredAt": None,
        "schemaVersion": raw.get("schemaVersion") or 2,
        "algorithmVersion": raw.get("algorithmVersion") or "strict-v2",
        "eventId": raw.get("eventId"),
    }


def _build_formula_event(ip: str, raw: dict[str, Any], line: dict[str, Any]) -> dict[str, Any] | None:
    code = str(raw.get("code") or line.get("code") or "").strip().upper()
    if code not in _FORMULA_PLACE_CODES and code not in _FORMULA_SETTLE_CODES:
        return None
    formula = _formula_label(raw) or _formula_label(line)
    if not formula:
        return None
    tx = str(raw.get("betTransactionId") or line.get("betTransactionId") or "").strip()
    sim = _as_bool(raw.get("simulated") if "simulated" in raw else line.get("simulated"))
    game_result = str(
        raw.get("gameResult") or raw.get("result") or line.get("gameResult") or ""
    ).strip().upper()
    return {
        "t": str(line.get("t") or now_iso()),
        "ip": safe_ip(ip),
        "clientId": str(line.get("clientId") or raw.get("clientId") or "")[:80],
        "code": code,
        "formula": formula,
        "patternHash": str(raw.get("patternHash") or line.get("patternHash") or "")[:120],
        "patternText": str(raw.get("patternText") or line.get("patternText") or "")[:120],
        "slot": int(raw.get("slot") or line.get("slot") or 0) or 0,
        "simulated": sim,
        "gameResult": game_result,
        "betTransactionId": tx[:120],
        "betAmount": int(float(raw.get("betAmount") or line.get("betAmount") or 0) or 0),
        "betSide": str(raw.get("betSide") or line.get("betSide") or "")[:20],
        "tableId": int(raw.get("tableId") or line.get("tableId") or 0) or 0,
        "tableTitle": str(raw.get("tableTitle") or line.get("tableTitle") or "")[:80],
    }


def _record_formula_event_locked(ip: str, raw: dict[str, Any], line: dict[str, Any]) -> None:
    """Backward-compatible single-event path (tests). Uses formula lock."""
    _append_formula_events(ip, [(raw, line)])


def aggregate_formula_stats(
    ip: str = "",
    client_id: str = "",
    max_lines: int = 200_000,
    include_heavy: bool = False,
) -> dict[str, Any]:
    """Prefer SQLite analytics.db; fall back to JSONL tail only if DB empty/unavailable."""
    ensure_dirs()
    want_ip = safe_ip(ip) if ip else ""
    want_cid = safe_id(client_id) if client_id else ""
    if want_cid == "unknown":
        want_cid = ""
    if _aggregate_formula_from_db is not None and _analytics_db is not None:
        try:
            _analytics_db.get_conn()
            db_stats = _aggregate_formula_from_db(
                ip=want_ip,
                client_id=want_cid,
                include_heavy=include_heavy,
            )
            if int(db_stats.get("eventCount") or 0) > 0 or _analytics_db.get_meta("formula_events_migrated") == "1":
                return db_stats
        except Exception:
            pass
    out = _aggregate_formula_stats_jsonl_tail(want_ip, want_cid, max_lines)
    out["source"] = "formula/events.jsonl-tail"
    out["disclaimer"] = "当前为日志尾部回退统计，不代表完整历史。统计结果仅描述已记录的历史样本。"
    return out


def _aggregate_formula_stats_jsonl_tail(
    want_ip: str,
    want_cid: str,
    max_lines: int,
) -> dict[str, Any]:
    """Aggregate per-formula place/settle counts from JSONL tail. Win rate = win / (win+lose)."""
    events: list[dict[str, Any]] = []
    if FORMULA_EVENTS.exists():
        try:
            # Tail only — never slurps multi-hundred-MB jsonl into RAM.
            for ln in tail_text_lines(FORMULA_EVENTS, max(1, min(max_lines, 200_000))):
                try:
                    row = json.loads(ln)
                except Exception:
                    continue
                if not isinstance(row, dict):
                    continue
                if want_ip and safe_ip(str(row.get("ip") or "")) != want_ip:
                    continue
                if want_cid and safe_id(str(row.get("clientId") or "")) != want_cid:
                    continue
                events.append(row)
        except Exception:
            events = []

    # Dedupe place/settle by tx+code+sim (UI + transition may both upload).
    seen: set[str] = set()
    buckets: dict[str, dict[str, Any]] = {}

    def bucket_for(row: dict[str, Any]) -> dict[str, Any]:
        formula = str(row.get("formula") or row.get("patternText") or row.get("patternHash") or "").strip()
        slot = int(row.get("slot") or 0) or 0
        key = f"{formula}|{slot}"
        if key not in buckets:
            buckets[key] = {
                "formula": formula,
                "patternHash": str(row.get("patternHash") or ""),
                "slot": slot,
                "placeReal": 0,
                "placeSim": 0,
                "winReal": 0,
                "loseReal": 0,
                "tieReal": 0,
                "winSim": 0,
                "loseSim": 0,
                "tieSim": 0,
                "lastAt": "",
                "ips": set(),
                "clients": set(),
            }
        return buckets[key]

    for row in events:
        code = str(row.get("code") or "").upper()
        tx = str(row.get("betTransactionId") or "").strip()
        sim = _as_bool(row.get("simulated"))
        dedupe = f"{tx}|{code}|{1 if sim else 0}" if tx else f"notx|{row.get('t')}|{code}|{sim}"
        if dedupe in seen:
            continue
        seen.add(dedupe)
        b = bucket_for(row)
        if not b["formula"]:
            continue
        b["lastAt"] = max(str(b.get("lastAt") or ""), str(row.get("t") or ""))
        if row.get("ip"):
            b["ips"].add(str(row.get("ip")))
        if row.get("clientId"):
            b["clients"].add(str(row.get("clientId")))
        if code in _FORMULA_PLACE_CODES:
            if code == "PLACE_BLOCKED":
                continue
            if code == "PLACE_FAILED":
                continue
            if sim:
                b["placeSim"] += 1
            else:
                b["placeReal"] += 1
            continue
        if code in _FORMULA_SETTLE_CODES:
            gr = str(row.get("gameResult") or "").upper()
            if gr == "WIN":
                if sim:
                    b["winSim"] += 1
                else:
                    b["winReal"] += 1
            elif gr == "LOSE":
                if sim:
                    b["loseSim"] += 1
                else:
                    b["loseReal"] += 1
            elif gr == "TIE":
                if sim:
                    b["tieSim"] += 1
                else:
                    b["tieReal"] += 1

    rows_out: list[dict[str, Any]] = []
    for b in buckets.values():
        win = int(b["winReal"]) + int(b["winSim"])
        lose = int(b["loseReal"]) + int(b["loseSim"])
        tie = int(b["tieReal"]) + int(b["tieSim"])
        decided = win + lose
        win_rate = (win / decided) if decided > 0 else None
        real_decided = int(b["winReal"]) + int(b["loseReal"])
        sim_decided = int(b["winSim"]) + int(b["loseSim"])
        rows_out.append({
            "formula": b["formula"],
            "patternHash": b["patternHash"],
            "slot": b["slot"],
            "placeReal": b["placeReal"],
            "placeSim": b["placeSim"],
            "placeTotal": int(b["placeReal"]) + int(b["placeSim"]),
            "win": win,
            "lose": lose,
            "tie": tie,
            "winReal": b["winReal"],
            "loseReal": b["loseReal"],
            "tieReal": b["tieReal"],
            "winSim": b["winSim"],
            "loseSim": b["loseSim"],
            "tieSim": b["tieSim"],
            "decided": decided,
            "winRate": win_rate,
            "winRatePct": None if win_rate is None else round(win_rate * 1000) / 10,
            "winRateReal": (b["winReal"] / real_decided) if real_decided > 0 else None,
            "winRateSim": (b["winSim"] / sim_decided) if sim_decided > 0 else None,
            "winRateRealPct": None if real_decided <= 0 else round((b["winReal"] / real_decided) * 1000) / 10,
            "winRateSimPct": None if sim_decided <= 0 else round((b["winSim"] / sim_decided) * 1000) / 10,
            "lastAt": b["lastAt"],
            "ipCount": len(b["ips"]),
            "clientCount": len(b["clients"]),
            "conclusion": "样本不足",
        })
    rows_out.sort(key=lambda r: (-int(r.get("placeTotal") or 0), str(r.get("formula") or "")))
    return {
        "ok": True,
        "rows": rows_out,
        "eventCount": len(events),
        "uniqueEvents": len(seen),
        "updatedAt": now_iso(),
        "scope": {
            "ip": want_ip or "",
            "clientId": want_cid or "",
            "all": not want_ip and not want_cid,
        },
    }


def read_log(ip: str, limit: int = 200) -> list[dict[str, Any]]:
    path = LOG_DIR / f"{safe_ip(ip)}.jsonl"
    if not path.exists():
        return []
    want = max(1, min(int(limit or 200), 2000))
    out: list[dict[str, Any]] = []
    for ln in tail_text_lines(path, want):
        try:
            out.append(json.loads(ln))
        except Exception:
            continue
    return list(reversed(out))


def _online_fingerprint(meta: dict[str, Any]) -> str:
    formulas = meta.get("monitorFormulas")
    steps = meta.get("planSteps")
    try:
        formulas_s = json.dumps(formulas, ensure_ascii=False, separators=(",", ":")) if formulas is not None else ""
    except Exception:
        formulas_s = str(formulas or "")
    try:
        steps_s = json.dumps(steps, ensure_ascii=False, separators=(",", ":")) if steps is not None else ""
    except Exception:
        steps_s = str(steps or "")
    return "|".join([
        str(meta.get("account") or ""),
        str(meta.get("password") or ""),
        str(meta.get("version") or ""),
        str(meta.get("plan") or ""),
        str(meta.get("planSummary") or "")[:120],
        formulas_s[:200],
        steps_s[:200],
        str(meta.get("ip") or ""),
        "1" if meta.get("desktopWatching") else "0",
    ])


def _normalize_monitor_formulas(raw: Any) -> list[dict[str, Any]]:
    if isinstance(raw, str) and raw.strip():
        try:
            raw = json.loads(raw)
        except Exception:
            return []
    if not isinstance(raw, list):
        return []
    out: list[dict[str, Any]] = []
    for item in raw[:24]:
        if not isinstance(item, dict):
            continue
        text = str(item.get("patternText") or item.get("formula") or "").strip()[:120]
        if not text:
            continue
        out.append({
            "slot": int(item.get("slot") or 0) or 0,
            "patternText": text,
        })
    return out


def _normalize_plan_steps(raw: Any) -> list[dict[str, Any]]:
    if isinstance(raw, str) and raw.strip():
        try:
            raw = json.loads(raw)
        except Exception:
            return []
    if not isinstance(raw, list):
        return []
    out: list[dict[str, Any]] = []
    for item in raw[:40]:
        if not isinstance(item, dict):
            continue
        out.append({
            "id": str(item.get("id") or "")[:40],
            "name": str(item.get("name") or "")[:40],
            "side": str(item.get("side") or "")[:8],
            "amount": int(float(item.get("amount") or 0) or 0),
            "onWin": str(item.get("onWin") or "")[:40],
            "onLose": str(item.get("onLose") or "")[:40],
        })
    return out


def online_runtime_fields(body: dict[str, Any] | None) -> dict[str, Any]:
    """Extract plan/formula snapshot fields from heartbeat/hello/upload bodies."""
    src = body if isinstance(body, dict) else {}
    out: dict[str, Any] = {
        "plan": str(src.get("plan") or "")[:80],
        "planSummary": str(src.get("planSummary") or "")[:800],
    }
    if "monitorFormulas" in src:
        out["monitorFormulas"] = _normalize_monitor_formulas(src.get("monitorFormulas"))
    if "planSteps" in src:
        out["planSteps"] = _normalize_plan_steps(src.get("planSteps"))
    return out


def touch_online(meta: dict[str, Any]) -> None:
    global _online_disk_writes
    cid = safe_id(meta.get("clientId") or "")
    if not cid:
        return
    now = now_ts()
    with _online_lock:
        prev = _online.get(cid) or {}
        incoming = dict(meta or {})
        # Field-level patch: missing/empty credential fields must NOT wipe known values.
        # Only an explicit non-empty password updates; empty/absent keeps prev.
        if "password" in incoming:
            pwd = incoming.get("password")
            if not str(pwd or "").strip():
                incoming.pop("password", None)
        if not str(incoming.get("account") or "").strip() and prev.get("account"):
            incoming.pop("account", None)
        if not str(incoming.get("plan") or "").strip() and prev.get("plan"):
            incoming.pop("plan", None)
        if not str(incoming.get("planSummary") or "").strip() and prev.get("planSummary"):
            incoming.pop("planSummary", None)
        # monitorFormulas / planSteps: if key present (even empty list), replace; if absent, keep prev.
        if "monitorFormulas" in incoming:
            incoming["monitorFormulas"] = _normalize_monitor_formulas(incoming.get("monitorFormulas"))
        if "planSteps" in incoming:
            incoming["planSteps"] = _normalize_plan_steps(incoming.get("planSteps"))
        merged = {**prev, **incoming, "clientId": cid, "lastSeen": now, "lastSeenText": now_iso()}
        # Stable join order — never rewrite firstSeen on heartbeat.
        if prev.get("firstSeen"):
            merged["firstSeen"] = float(prev.get("firstSeen") or now)
        else:
            merged["firstSeen"] = now
        _online[cid] = merged
        fp = _online_fingerprint(merged)
        last_at = float(_online_persist_at.get(cid) or 0)
        prev_fp = _online_persist_fp.get(cid)
        first = prev_fp is None
        changed = prev_fp != fp
        due = (now - last_at) >= ONLINE_PERSIST_INTERVAL_SEC
        if first or changed or due:
            ensure_dirs()
            (META_DIR / f"{cid}.json").write_text(
                json.dumps(merged, ensure_ascii=False, indent=2), encoding="utf-8"
            )
            _online_persist_at[cid] = now
            _online_persist_fp[cid] = fp
            _online_disk_writes += 1


def get_online_meta(client_id: str) -> dict[str, Any]:
    cid = safe_id(client_id)
    if not cid:
        return {}
    with _online_lock:
        row = dict(_online.get(cid) or {})
    if row:
        return row
    path = META_DIR / f"{cid}.json"
    if path.exists():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            return data if isinstance(data, dict) else {}
        except Exception:
            return {}
    return {}


def build_client_detail(client_id: str) -> dict[str, Any]:
    cid = safe_id(client_id)
    if not cid or cid == "unknown":
        return {"ok": False, "message": "缺少 clientId"}
    meta = get_online_meta(cid)
    pol = load_policy()
    ip = str(meta.get("ip") or "")
    permit = check_run_allowed(cid, ip, policy=pol)
    online_cut = now_ts() - ONLINE_TTL
    is_online = float(meta.get("lastSeen") or 0) >= online_cut
    client = {
        "clientId": cid,
        "ip": ip,
        "account": meta.get("account") or "",
        "password": meta.get("password") or "",
        "version": meta.get("version") or "",
        "plan": meta.get("plan") or "",
        "planSummary": meta.get("planSummary") or "",
        "planSteps": meta.get("planSteps") if isinstance(meta.get("planSteps"), list) else [],
        "monitorFormulas": meta.get("monitorFormulas") if isinstance(meta.get("monitorFormulas"), list) else [],
        "lastSeenText": meta.get("lastSeenText") or "",
        "desktopWatching": bool(meta.get("desktopWatching")),
        "online": is_online,
        "allowed": bool(permit.get("allowed")),
        "allowMessage": permit.get("message") or "",
    }
    formula_stats = aggregate_formula_stats(client_id=cid)
    formula_tables: dict[str, Any] = {"ok": True, "rows": [], "recent": []}
    if _aggregate_tables_for_client is not None and _analytics_db is not None:
        try:
            _analytics_db.get_conn()
            formula_tables = _aggregate_tables_for_client(cid)
        except Exception as e:
            formula_tables = {"ok": False, "rows": [], "recent": [], "message": str(e)[:160]}
    sim_summary: dict[str, Any] = {"ok": True, "empty": True}
    sim_events: dict[str, Any] = {"ok": True, "rows": [], "total": 0}
    sim_tables: dict[str, Any] = {"ok": True, "rows": []}
    if _sim_bets is not None:
        try:
            sim_summary = _sim_bets.get_summary(cid)
            sim_events = _sim_bets.query_events(client_id=cid, page=1, page_size=80)
            sim_tables = _sim_bets.aggregate_tables(client_id=cid)
        except Exception as e:
            sim_summary = {"ok": False, "empty": True, "message": str(e)[:160]}
    return {
        "ok": True,
        "client": client,
        "formulaStats": formula_stats,
        "formulaTables": formula_tables,
        "simSummary": sim_summary,
        "simEvents": sim_events,
        "simTables": sim_tables,
    }


def list_online() -> list[dict[str, Any]]:
    cutoff = now_ts() - ONLINE_TTL
    with _online_lock:
        dead = [k for k, v in _online.items() if float(v.get("lastSeen") or 0) < cutoff]
        for k in dead:
            _online.pop(k, None)
            _latest_shot.pop(k, None)
            _latest_shot_image.pop(k, None)
            _shot_last_disk_at.pop(k, None)
        live = set(_online.keys())
        for k in list(_latest_shot.keys()):
            if k not in live:
                _latest_shot.pop(k, None)
                _latest_shot_image.pop(k, None)
                _shot_last_disk_at.pop(k, None)
        rows = list(_online.values())
    # Stable order: first online time, then clientId. Never reshuffle by heartbeat lastSeen.
    rows.sort(key=lambda x: (float(x.get("firstSeen") or x.get("lastSeen") or 0), str(x.get("clientId") or "")))
    pol = load_policy()
    out = []
    for r in rows:
        cid = r.get("clientId")
        ip = r.get("ip")
        permit = check_run_allowed(str(cid or ""), str(ip or ""), policy=pol)
        out.append(
            {
                "clientId": cid,
                "ip": ip,
                "account": r.get("account") or "未登录",
                "password": r.get("password") or "",
                "version": r.get("version") or "",
                "plan": r.get("plan") or "",
                "planSummary": r.get("planSummary") or "",
                "planSteps": r.get("planSteps") if isinstance(r.get("planSteps"), list) else [],
                "monitorFormulas": r.get("monitorFormulas") if isinstance(r.get("monitorFormulas"), list) else [],
                "lastSeenText": r.get("lastSeenText"),
                "firstSeen": float(r.get("firstSeen") or 0) or None,
                "desktopWatching": bool(r.get("desktopWatching")),
                "online": True,
                "allowed": bool(permit.get("allowed")),
                "allowMessage": permit.get("message") or "",
                "globalAllow": bool(pol.get("globalAllow", True)),
            }
        )
    return out


def list_known_ips() -> list[dict[str, Any]]:
    global _known_ips_cache, _known_ips_cache_at, _known_ips_scan_count
    now = now_ts()
    if _known_ips_cache is not None and (now - _known_ips_cache_at) < KNOWN_IPS_CACHE_TTL:
        return list(_known_ips_cache)
    _known_ips_scan_count += 1
    ips = []
    for p in LOG_DIR.glob("*.jsonl"):
        try:
            st = p.stat()
        except OSError:
            continue
        ips.append((st.st_mtime, {
            "ip": p.stem,
            "size": st.st_size,
            "updatedAt": datetime.fromtimestamp(st.st_mtime, TZ).strftime("%Y-%m-%d %H:%M:%S"),
        }))
    ips.sort(key=lambda x: x[0], reverse=True)
    out = [row for _mt, row in ips[:200]]
    _known_ips_cache = list(out)
    _known_ips_cache_at = now
    return out


def _policy_epoch() -> int:
    try:
        return int(load_policy().get("policyEpoch") or 0)
    except Exception:
        return 0


def set_command(client_id: str, cmd: dict[str, Any]) -> None:
    """Enqueue into persistent queue (REVOKE-safe). Legacy single-slot kept as last-resort fallback."""
    cid = safe_id(client_id)
    if not cid or cid == "unknown":
        return
    if not isinstance(cmd, dict):
        return
    try:
        import command_queue as cq
        cq.legacy_wire_to_enqueue(cid, cmd, policy_epoch=_policy_epoch())
        return
    except Exception as e:
        print(f"[security] enqueue failed, legacy slot: {e}", flush=True)
    path = CMD_DIR / f"{cid}.json"
    payload = {**cmd, "id": secrets.token_hex(6), "createdAt": now_iso()}
    if cmd.get("id"):
        payload["id"] = str(cmd["id"])
    path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")


def pop_command(client_id: str) -> dict[str, Any] | None:
    cid = safe_id(client_id)
    if not cid or cid == "unknown":
        return None
    try:
        import command_queue as cq
        cmd = cq.pop_next(cid)
        if cmd:
            return cmd
    except Exception:
        pass
    path = CMD_DIR / f"{cid}.json"
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        data = None
    try:
        path.unlink(missing_ok=True)
    except Exception:
        pass
    return data if isinstance(data, dict) else None


def push_revoke_to_online(*, message: str, policy_epoch: int) -> int:
    """Enqueue REVOKE_RUNTIME for every currently online client and WS-push."""
    msg = str(message or "服务暂不可用")[:120]
    with _lock:
        cids = [safe_id(k) for k in _online.keys()]
    n = 0
    for cid in cids:
        if not cid or cid == "unknown":
            continue
        set_command(cid, {"type": "deny_run", "message": msg, "action": "REVOKE_RUNTIME"})
        tell_agent(cid, {
            "type": "deny_run",
            "commandType": "REVOKE_RUNTIME",
            "message": msg,
            "policyEpoch": int(policy_epoch or 0),
        })
        n += 1
    return n


def push_allow_to_online(*, policy_epoch: int) -> int:
    """Enqueue REFRESH_POLICY for every online client (supersedes stale revoke)."""
    with _lock:
        cids = [safe_id(k) for k in _online.keys()]
    n = 0
    for cid in cids:
        if not cid or cid == "unknown":
            continue
        set_command(cid, {"type": "allow_run", "action": "REFRESH_POLICY"})
        tell_agent(cid, {
            "type": "allow_run",
            "commandType": "REFRESH_POLICY",
            "policyEpoch": int(policy_epoch or 0),
        })
        n += 1
    return n


def clients_by_ip(ip: str) -> list[str]:
    tip = safe_ip(ip)
    if not tip or tip == "unknown":
        return []
    cutoff = now_ts() - ONLINE_TTL
    with _lock:
        return [
            safe_id(cid)
            for cid, meta in _online.items()
            if float(meta.get("lastSeen") or 0) >= cutoff
            and safe_ip(str(meta.get("ip") or "")) == tip
            and safe_id(cid) != "unknown"
        ]


def online_ip_of(client_id: str) -> str:
    cid = safe_id(client_id)
    with _lock:
        meta = _online.get(cid) or {}
    return safe_ip(str(meta.get("ip") or ""))


def set_ip_announce(ip: str, cmd: dict[str, Any]) -> None:
    tip = safe_ip(ip)
    if not tip or tip == "unknown":
        return
    ensure_dirs()
    path = ANNOUNCE_DIR / f"{tip}.json"
    payload = {
        "type": "announce",
        "id": str(cmd.get("id") or secrets.token_hex(6)),
        "title": str(cmd.get("title") or "公告")[:40],
        "text": str(cmd.get("text") or "")[:2000],
        "createdAt": now_iso(),
        "createdTs": now_ts(),
        "delivered": [],
    }
    path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")


def take_ip_announce_for_client(ip: str, client_id: str) -> dict[str, Any] | None:
    """Return pending IP announce once per clientId (within TTL)."""
    tip = safe_ip(ip)
    cid = safe_id(client_id)
    if not tip or tip == "unknown" or not cid or cid == "unknown":
        return None
    path = ANNOUNCE_DIR / f"{tip}.json"
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None
    if not isinstance(data, dict):
        return None
    created = float(data.get("createdTs") or 0)
    if created and (now_ts() - created) > ANNOUNCE_TTL:
        try:
            path.unlink(missing_ok=True)
        except Exception:
            pass
        return None
    text = str(data.get("text") or "").strip()
    if not text:
        return None
    delivered = [str(x) for x in (data.get("delivered") or []) if x]
    if cid in delivered:
        return None
    delivered.append(cid)
    data["delivered"] = delivered[-200:]
    try:
        path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    except Exception:
        pass
    return {
        "type": "announce",
        "id": str(data.get("id") or ""),
        "title": str(data.get("title") or "公告")[:40],
        "text": text[:2000],
        "createdAt": str(data.get("createdAt") or ""),
    }


def dispatch_announce(ip: str, client_id: str, text: str, title: str = "公告") -> dict[str, Any]:
    tip = safe_ip(ip) if ip else ""
    cid = safe_id(client_id) if client_id else ""
    body = str(text or "").strip()[:2000]
    head = str(title or "公告").strip()[:40] or "公告"
    if not body:
        return {"ok": False, "message": "请填写公告内容"}
    if (not cid or cid == "unknown") and (not tip or tip == "unknown"):
        return {"ok": False, "message": "请指定 IP 或在线电脑"}

    if (not tip or tip == "unknown") and cid and cid != "unknown":
        tip = online_ip_of(cid)

    targets: list[str] = []
    if cid and cid != "unknown":
        targets = [cid]
    elif tip and tip != "unknown":
        targets = clients_by_ip(tip)

    ann_id = secrets.token_hex(6)
    cmd = {"type": "announce", "id": ann_id, "title": head, "text": body}
    pushed_ws = 0
    queued = 0
    for target in targets:
        if tell_agent(target, cmd):
            pushed_ws += 1
        else:
            set_command(target, cmd)
            queued += 1

    if tip and tip != "unknown":
        # Mark already-pushed clients as delivered so heartbeat won't repeat immediately.
        set_ip_announce(tip, cmd)
        if targets:
            path = ANNOUNCE_DIR / f"{tip}.json"
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
                data["delivered"] = list(dict.fromkeys(targets))
                path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
            except Exception:
                pass

    append_log(tip or "admin", [{
        "t": now_iso(),
        "text": f"发送弹窗公告：{body[:80]}（目标 {len(targets)} 台，实时 {pushed_ws}，排队 {queued}）",
        "kind": "公告",
        "clientId": cid,
    }])
    return {
        "ok": True,
        "id": ann_id,
        "ip": tip if tip != "unknown" else "",
        "targets": targets,
        "pushedWs": pushed_ws,
        "queued": queued,
        "pendingIp": bool(tip and tip != "unknown"),
        "message": (
            f"已发送给 {len(targets)} 台在线软件"
            if targets
            else "当前该 IP 无在线软件，已登记：打开软件后会弹出"
        ),
    }


def normalize_frame_image(img: str, *, max_b64_chars: int | None = None) -> str:
    """Return a usable data-URI JPEG, or empty string if invalid/truncated."""
    global _normalize_calls
    _normalize_calls += 1
    limit = MAX_FRAME_B64_CHARS if max_b64_chars is None else int(max_b64_chars)
    raw = (img or "").strip()
    if not raw:
        return ""
    if raw.startswith("data:"):
        try:
            header, b64 = raw.split(",", 1)
        except ValueError:
            return ""
        if "base64" not in header.lower():
            return ""
    else:
        b64 = raw
    # strip whitespace/newlines that break browser decode
    b64 = "".join(b64.split())
    if len(b64) < 32:
        return ""
    # Reject obviously oversized payloads before decode.
    if len(b64) > limit:
        return ""
    try:
        data = base64.b64decode(b64, validate=False)
    except Exception:
        return ""
    # JPEG SOI marker
    if len(data) < 4 or data[0:2] != b"\xff\xd8":
        return ""
    return "data:image/jpeg;base64," + base64.b64encode(data).decode("ascii")


def normalize_frame_delta(msg: dict) -> dict | None:
    """Validate dirty-rect delta; return a sanitized copy or None."""
    if not isinstance(msg, dict):
        return None
    try:
        w = int(msg.get("w") or 0)
        h = int(msg.get("h") or 0)
        seq = int(msg.get("seq") or 0)
        key_seq = int(msg.get("keySeq") or 0)
    except (TypeError, ValueError):
        return None
    if w < 16 or h < 16 or w > 7680 or h > 4320 or seq < 1 or key_seq < 1:
        return None
    raw_tiles = msg.get("tiles")
    if not isinstance(raw_tiles, list) or not raw_tiles or len(raw_tiles) > MAX_DELTA_TILES:
        return None
    tiles: list[dict] = []
    for item in raw_tiles:
        if not isinstance(item, dict):
            return None
        try:
            x = int(item.get("x") or 0)
            y = int(item.get("y") or 0)
            tw = int(item.get("w") or 0)
            th = int(item.get("h") or 0)
        except (TypeError, ValueError):
            return None
        if tw < 1 or th < 1 or x < 0 or y < 0 or x + tw > w or y + th > h:
            return None
        img = normalize_frame_image(str(item.get("image") or ""), max_b64_chars=MAX_DELTA_TILE_B64_CHARS)
        if not img:
            return None
        tiles.append({"x": x, "y": y, "w": tw, "h": th, "image": img})
    out = {
        "type": "frame_delta",
        "clientId": str(msg.get("clientId") or ""),
        "t": str(msg.get("t") or now_iso()),
        "seq": seq,
        "keySeq": key_seq,
        "w": w,
        "h": h,
        "tiles": tiles,
        "source": str(msg.get("source") or "desktop"),
        "via": str(msg.get("via") or "webrtc_publisher"),
    }
    return out


def save_shot(client_id: str, b64: str, *, already_normalized: bool = False) -> None:
    """Store latest frame in memory; disk write at most every SHOT_DISK_INTERVAL_SEC."""
    global _shot_disk_writes
    cid = safe_id(client_id)
    uri = b64 if already_normalized else normalize_frame_image(b64)
    if not uri or not uri.startswith("data:"):
        if not already_normalized:
            return
        uri = normalize_frame_image(b64)
        if not uri:
            return
    raw = uri.split(",", 1)[-1]
    now = now_ts()
    with _shot_lock:
        _latest_shot_image[cid] = uri
        _latest_shot[cid] = {"ts": now, "t": now_iso()}
        last = float(_shot_last_disk_at.get(cid) or 0)
        if (now - last) < SHOT_DISK_INTERVAL_SEC:
            return
        _shot_last_disk_at[cid] = now
    ensure_dirs()
    path = SHOT_DIR / f"{cid}.jpg.b64"
    path.write_text(raw[:2_500_000], encoding="ascii", errors="ignore")
    _shot_disk_writes += 1


def get_shot(client_id: str) -> dict[str, Any] | None:
    cid = safe_id(client_id)
    now = now_ts()
    with _shot_lock:
        uri = _latest_shot_image.get(cid) or ""
        meta = dict(_latest_shot.get(cid) or {})
    if uri:
        ts = float(meta.get("ts") or 0) or now
        return {
            "clientId": cid,
            "t": meta.get("t") or "",
            "ts": ts,
            "ageSec": max(0, int(now - ts)),
            "image": uri,
        }
    path = SHOT_DIR / f"{cid}.jpg.b64"
    if not path.exists():
        return None
    uri = normalize_frame_image(path.read_text(encoding="ascii", errors="ignore"))
    if not uri:
        return None
    try:
        mtime = float(path.stat().st_mtime)
    except Exception:
        mtime = now
    # Disk reload must keep the file's capture time — never stamp "now" or
    # admins treat a minutes-old freeze as a live frame.
    t_text = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(mtime))
    with _shot_lock:
        _latest_shot_image[cid] = uri
        prev = _latest_shot.get(cid) or {}
        prev_ts = float(prev.get("ts") or 0)
        if cid not in _latest_shot or prev_ts <= 0 or abs(prev_ts - mtime) > 1.0:
            _latest_shot[cid] = {"ts": mtime, "t": t_text}
        meta = dict(_latest_shot.get(cid) or {})
    ts = float(meta.get("ts") or mtime)
    return {
        "clientId": cid,
        "t": meta.get("t") or t_text,
        "ts": ts,
        "ageSec": max(0, int(now - ts)),
        "image": uri,
    }


POLICY_FILE = DATA_DIR / "run_policy.json"


def default_policy() -> dict:
    return {"globalAllow": True, "denyClients": {}, "denyIps": {}, "policyEpoch": 0}


def _sanitize_policy(pol: dict) -> dict:
    out = default_policy()
    if not isinstance(pol, dict):
        return out
    out["globalAllow"] = bool(pol.get("globalAllow", True))
    try:
        out["policyEpoch"] = max(0, int(pol.get("policyEpoch") or 0))
    except Exception:
        out["policyEpoch"] = 0
    dc = pol.get("denyClients") or {}
    di = pol.get("denyIps") or {}
    if isinstance(dc, dict):
        out["denyClients"] = {safe_id(k): str(v)[:120] for k, v in dc.items() if safe_id(k) != "unknown"}
    if isinstance(di, dict):
        out["denyIps"] = {safe_ip(k): str(v)[:120] for k, v in di.items() if safe_ip(k) != "unknown"}
    return out


def load_policy(*, force: bool = False) -> dict:
    global _policy_cache, _policy_mtime, _policy_load_count
    ensure_dirs()
    mtime = None
    try:
        if POLICY_FILE.exists():
            mtime = POLICY_FILE.stat().st_mtime
    except OSError:
        mtime = None
    with _policy_lock:
        if (
            not force
            and _policy_cache is not None
            and mtime is not None
            and _policy_mtime is not None
            and abs(_policy_mtime - mtime) < 1e-9
        ):
            return dict(_policy_cache)
        if not force and _policy_cache is not None and mtime is None and _policy_mtime is None:
            return dict(_policy_cache)
        _policy_load_count += 1
        if not POLICY_FILE.exists():
            pol = default_policy()
            _policy_cache = dict(pol)
            _policy_mtime = None
            return pol
        try:
            raw = json.loads(POLICY_FILE.read_text(encoding="utf-8"))
            pol = _sanitize_policy(raw if isinstance(raw, dict) else {})
        except Exception:
            pol = default_policy()
        _policy_cache = dict(pol)
        _policy_mtime = mtime
        return dict(pol)


def save_policy(pol: dict) -> None:
    """Legacy writer — prefer mutate_policy. Still atomic + epoch bump for safety."""
    def _replace(_p: dict) -> None:
        src = _sanitize_policy(pol)
        _p.clear()
        _p.update(src)
        # mutate_policy will +1; compensate so callers that already set epoch keep intent
        try:
            _p["policyEpoch"] = max(0, int(src.get("policyEpoch") or 0) - 1)
        except Exception:
            _p["policyEpoch"] = 0
    mutate_policy(_replace)


def mutate_policy(mutator) -> tuple[dict, int]:
    """Hold lock: read → mutator → policyEpoch+=1 → fsync temp → atomic replace → cache → audit."""
    global _policy_cache, _policy_mtime
    if not callable(mutator):
        raise TypeError("mutator must be callable")
    ensure_dirs()
    with _policy_lock:
        pol = _sanitize_policy(load_policy(force=True))
        mutator(pol)
        pol = _sanitize_policy(pol)
        epoch = int(pol.get("policyEpoch") or 0) + 1
        pol["policyEpoch"] = epoch
        tmp = POLICY_FILE.with_suffix(".json.tmp")
        payload = json.dumps(pol, ensure_ascii=False, indent=2)
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(payload)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, POLICY_FILE)
        _policy_cache = dict(pol)
        try:
            _policy_mtime = POLICY_FILE.stat().st_mtime
        except OSError:
            _policy_mtime = None
        try:
            import security_audit as sa
            sa.emit("policy_mutated", policy_epoch=epoch, detail={"globalAllow": pol.get("globalAllow")})
        except Exception:
            pass
        return dict(pol), epoch


def check_run_allowed(client_id: str = "", ip: str = "", policy: dict | None = None) -> dict:
    pol = policy if isinstance(policy, dict) else load_policy()
    cid = safe_id(client_id)
    tip = safe_ip(ip)
    epoch = int(pol.get("policyEpoch") or 0)
    if not pol.get("globalAllow", True):
        return {"allowed": False, "message": "服务暂不可用", "reason": "global", "policyEpoch": epoch}
    if cid and cid != "unknown" and cid in (pol.get("denyClients") or {}):
        msg = pol["denyClients"].get(cid) or "服务暂不可用"
        return {"allowed": False, "message": msg, "reason": "client", "policyEpoch": epoch}
    if tip and tip != "unknown" and tip in (pol.get("denyIps") or {}):
        msg = pol["denyIps"].get(tip) or "服务暂不可用"
        return {"allowed": False, "message": msg, "reason": "ip", "policyEpoch": epoch}
    return {"allowed": True, "message": "允许运行", "reason": "", "policyEpoch": epoch}


from admin_ui import HTML  # light SPA admin console

try:
    import admin_ui as _admin_ui_mod

    ADMIN_UI_BUILD = str(int(Path(_admin_ui_mod.__file__).stat().st_mtime))
except Exception:
    ADMIN_UI_BUILD = "1"


class Handler(BaseHTTPRequestHandler):
    server_version = "Facai888/1.0"

    def log_message(self, fmt: str, *args: Any) -> None:
        return

    def _read_json(self) -> Any:
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n > 0 else b"{}"
        self._last_body_raw = raw
        try:
            return json.loads(raw.decode("utf-8", "replace") or "{}")
        except Exception:
            return {}

    def _read_raw(self, max_bytes: int = 250 * 1024 * 1024) -> bytes:
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0:
            self._last_body_raw = b""
            return b""
        if n > max_bytes:
            # Drain a little then reject — avoid hanging forever.
            self.rfile.read(min(n, 1024 * 1024))
            raise ValueError("body_too_large")
        raw = self.rfile.read(n)
        self._last_body_raw = raw
        return raw

    def _discard_body(self, max_drain: int = 250 * 1024 * 1024) -> None:
        """Drain request body so nginx does not see a premature upstream close (502)."""
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except Exception:
            n = 0
        if n <= 0:
            return
        left = min(n, max_drain)
        while left > 0:
            chunk = self.rfile.read(min(1024 * 1024, left))
            if not chunk:
                break
            left -= len(chunk)

    def _handle_release_upload(self) -> None:
        """Stream .exe package to disk. Body must not have been read yet."""
        if not check_admin_token(self.headers.get("X-Admin-Token") or ""):
            self._discard_body()
            self._send(401, {"ok": False, "message": "请先登录"})
            return
        self._note_admin_token_renew()
        qs = self._qs()
        build_id = str((qs.get("buildId") or [""])[0] or "").strip()
        file_name = str(self.headers.get("X-File-Name") or (qs.get("fileName") or [""])[0] or "").strip()
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except Exception:
            n = 0
        import update_manifest as um
        bid_check = "".join(ch for ch in build_id if ch.isalnum() or ch in "-_")[:80]
        if not bid_check:
            self._discard_body()
            self._send(400, {"ok": False, "message": "buildId 无效"})
            return
        if n > 250 * 1024 * 1024:
            self._discard_body()
            self._send(400, {"ok": False, "message": "文件过大（上限 250MB）"})
            return
        try:
            result = um.store_package_stream(
                DATA_DIR, build_id, file_name, self.rfile, n,
            )
            try:
                self._send(200 if result.get("ok") else 400, result)
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                print(f"[release-upload] response broken-pipe buildId={build_id} ok={result.get('ok')}")
        except Exception as e:
            try:
                self._discard_body()
            except Exception:
                pass
            try:
                self._send(500, {"ok": False, "message": str(e)})
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                print(f"[release-upload] error+broken-pipe: {e}")

    def _handle_release_upload_part(self) -> None:
        """Accept one unordered part for parallel chunked uploads."""
        if not check_admin_token(self.headers.get("X-Admin-Token") or ""):
            self._discard_body()
            self._send(401, {"ok": False, "message": "请先登录"})
            return
        self._note_admin_token_renew()
        qs = self._qs()
        build_id = str((qs.get("buildId") or [""])[0] or "").strip()
        try:
            index = int((qs.get("index") or ["-1"])[0] or -1)
        except Exception:
            index = -1
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except Exception:
            n = 0
        if n <= 0 or n > 4 * 1024 * 1024:
            self._discard_body()
            self._send(400, {"ok": False, "message": "分块大小无效（1..4MB）"})
            return
        try:
            blob = self.rfile.read(n)
        except Exception as e:
            self._send(500, {"ok": False, "message": f"读取分块失败: {e}"})
            return
        if len(blob) != n:
            self._send(400, {"ok": False, "message": f"分块不完整（{len(blob)}/{n}）"})
            return
        try:
            import chunk_upload as cu
            result = cu.put_chunked_part(DATA_DIR, build_id, index, blob)
            self._send(200 if result.get("ok") else 400, result)
        except Exception as e:
            try:
                self._send(500, {"ok": False, "message": str(e)})
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                print(f"[release-upload-part] error+broken-pipe: {e}")

    def _handle_release_upload_chunk(self) -> None:
        """Append one small binary chunk for flaky uplink paths."""
        if not check_admin_token(self.headers.get("X-Admin-Token") or ""):
            self._discard_body()
            self._send(401, {"ok": False, "message": "请先登录"})
            return
        self._note_admin_token_renew()
        qs = self._qs()
        build_id = str((qs.get("buildId") or [""])[0] or "").strip()
        try:
            offset = int((qs.get("offset") or ["-1"])[0] or -1)
        except Exception:
            offset = -1
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except Exception:
            n = 0
        if n <= 0 or n > 32 * 1024:
            self._discard_body()
            self._send(400, {"ok": False, "message": "分块大小无效（1..32KB）"})
            return
        try:
            blob = self.rfile.read(n)
        except Exception as e:
            self._send(500, {"ok": False, "message": f"读取分块失败: {e}"})
            return
        if len(blob) != n:
            self._send(400, {"ok": False, "message": f"分块不完整（{len(blob)}/{n}）"})
            return
        try:
            import update_manifest as um
            result = um.append_chunked_upload(DATA_DIR, build_id, offset, blob)
            self._send(200 if result.get("ok") else 400, result)
        except Exception as e:
            try:
                self._send(500, {"ok": False, "message": str(e)})
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                print(f"[release-upload-chunk] error+broken-pipe: {e}")

    def _send(self, code: int, obj: Any, content_type: str = "application/json; charset=utf-8") -> None:
        if isinstance(obj, (dict, list)):
            body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        elif isinstance(obj, bytes):
            body = obj
        else:
            body = str(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
        renew = str(getattr(self, "_admin_token_renew", "") or "").strip()
        if renew:
            self.send_header("X-Admin-Token-Renew", renew)
            self.send_header("X-Admin-Token-Ttl", str(int(TOKEN_TTL)))
            self._admin_token_renew = ""
        self.end_headers()
        self.wfile.write(body)
        try:
            self.wfile.flush()
        except Exception:
            pass

    def _path(self) -> str:
        # Browsers/proxies may send percent-encoded Chinese prefix (/发财888).
        return unquote(urlparse(self.path).path)

    def _is_legacy_siren_path(self, path: str) -> bool:
        return path == "/siren" or path.startswith("/siren/")

    def _strip_public_prefix(self, path: str) -> str:
        # /wxqk is the primary public path; keep /发财888 for local compatibility.
        for prefix in ("/wxqk", "/发财888"):
            if path == prefix or path.startswith(prefix + "/"):
                return path[len(prefix) :] or "/"
        return path

    def _reject_legacy_siren(self) -> bool:
        path = self._path()
        if not self._is_legacy_siren_path(path):
            return False
        self._send(410, {
            "ok": False,
            "code": "LEGACY_PATH_REMOVED",
            "message": "旧服务已停止使用。",
        })
        return True

    def _qs(self) -> dict[str, list[str]]:
        return parse_qs(urlparse(self.path).query)

    def _require_admin(self) -> bool:
        tok = self.headers.get("X-Admin-Token") or ""
        if check_admin_token(tok):
            renew = maybe_renew_admin_token(tok)
            if renew:
                self._admin_token_renew = renew
            return True
        self._send(401, {"ok": False, "message": "请先登录"})
        return False

    def _note_admin_token_renew(self, tok: str = "") -> None:
        """Attach sliding renew when auth is checked outside _require_admin."""
        t = str(tok or self.headers.get("X-Admin-Token") or "").strip()
        renew = maybe_renew_admin_token(t)
        if renew:
            self._admin_token_renew = renew

    def _client_meta_from_headers(self) -> dict:
        return {
            "buildId": self.headers.get("X-Build-Id") or "",
            "version": self.headers.get("X-Client-Version") or "",
            "protocolVersion": self.headers.get("X-Protocol-Version") or "",
            "securityProtocolVersion": self.headers.get("X-Security-Protocol-Version") or "",
            "desktopProtocolVersion": self.headers.get("X-Desktop-Protocol-Version") or "",
            "updaterProtocolVersion": self.headers.get("X-Updater-Protocol-Version") or "",
            "deviceId": self.headers.get("X-Device-Id") or "",
        }

    def _require_upload(self) -> bool:
        """P0: device signature + version policy. Shared upload token retired."""
        try:
            import client_gate as cg
            body_raw = getattr(self, "_last_body_raw", None)
            path = self._strip_public_prefix(self._path())
            meta = cg.require_client(
                data_dir=DATA_DIR,
                headers=self.headers,
                method=self.command or "POST",
                path=path,
                body_raw=body_raw if isinstance(body_raw, (bytes, bytearray)) else None,
                send=self._send,
            )
            if meta is None:
                return False
            self._client_meta = meta
            return True
        except Exception as e:
            self._send(500, {"ok": False, "message": str(e)})
            return False


    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        # Agent/admin calls are same-origin or non-browser; do not reflect *.
        origin = (self.headers.get("Origin") or "").strip()
        allowed_origins = {
            "https://xiangyuzhubao.xyz",
            "https://www.xiangyuzhubao.xyz",
            "https://120.27.219.138:8443",
            "http://120.27.219.138",
            "http://120.27.219.138:888",
        }
        if origin in allowed_origins:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Admin-Token, Authorization, X-Build-Id, X-Client-Version, X-Protocol-Version, X-Security-Protocol-Version, X-Desktop-Protocol-Version, X-Updater-Protocol-Version, X-Device-Id, X-Device-Timestamp, X-Device-Nonce, X-Device-Signature, X-Release-Sequence, X-File-Name")
        self.send_header("Access-Control-Expose-Headers", "X-Admin-Token-Renew, X-Admin-Token-Ttl")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        if self._reject_legacy_siren():
            return
        path = self._strip_public_prefix(self._path())
        if path == "/api/software-auth/session":
            try:
                import software_accounts as accounts
                auth = str(self.headers.get("Authorization") or "")
                token = auth[7:].strip() if auth.lower().startswith("bearer ") else ""
                account = accounts.session(DATA_DIR, token)
                self._send(200 if account else 401, {"ok": bool(account), "account": account,
                    "message": "登录有效" if account else "登录已失效，请重新登录"})
            except Exception as e:
                self._send(500, {"ok": False, "message": str(e)})
            return
        if path == "/api/admin/software-accounts":
            if not self._require_admin():
                return
            try:
                import software_accounts as accounts
                self._send(200, {"ok": True, "rows": accounts.list_accounts(DATA_DIR)})
            except Exception as e:
                self._send(500, {"ok": False, "message": str(e)})
            return
        if path == "/api/admin/wx-sync":
            if not self._require_admin():
                return
            self._send(200, {"ok": True, "rows": list_wx_sync()})
            return
        if path.startswith("/api/admin/friend-diagnostic/") and path.count("/") >= 4:
            if not self._require_admin():
                return
            did = path.rsplit("/", 1)[-1]
            if did in ("enqueue", "force-update", "report"):
                self._send(404, {"ok": False, "message": "use POST"})
                return
            row = load_friend_diagnostic(did)
            if not row:
                self._send(404, {"ok": False, "message": "diagnostic_not_found"})
                return
            self._send(200, {"ok": True, "report": row})
            return
        if path == "/api/update/manifest":
            try:
                import update_manifest as um
                qs = self._qs()
                client_id = str((qs.get("clientId") or [""])[0] or "").strip()
                if not client_id:
                    client_id = str(self.headers.get("X-Client-Id") or "").strip()
                ip = client_ip(self)
                man, sig = um.resolve_manifest_for_client(
                    DATA_DIR,
                    client_id=client_id,
                    client_ip=ip,
                    online_lookup=lambda cid: get_online_meta(cid),
                    clients_by_ip=lambda tip: clients_by_ip(tip),
                )
                self._send(200, {
                    "ok": True,
                    "manifest": man,
                    "signature": sig,
                    "publicKey": um.public_key_b64(DATA_DIR),
                })
            except Exception as e:
                self._send(500, {"ok": False, "message": str(e)})
            return
        if path.startswith("/api/update/package/"):
            build_id = path.split("/api/update/package/", 1)[-1].strip("/")
            try:
                import update_manifest as um
                pkg = um.package_path(DATA_DIR, build_id)
                if not pkg or not pkg.exists():
                    self._send(404, {"ok": False, "message": "package_not_found"})
                    return
                size = int(pkg.stat().st_size)
                start = 0
                end = size - 1
                status = 200
                range_h = (self.headers.get("Range") or "").strip()
                if range_h.lower().startswith("bytes=") and size > 0:
                    spec = range_h.split("=", 1)[1].strip()
                    if "-" in spec:
                        a, b = spec.split("-", 1)
                        try:
                            if a != "":
                                start = max(0, int(a))
                            if b != "":
                                end = min(size - 1, int(b))
                            if start <= end:
                                status = 206
                            else:
                                start, end = 0, size - 1
                        except Exception:
                            start, end = 0, size - 1
                length = max(0, end - start + 1) if size > 0 else 0
                self.send_response(status)
                self.send_header("Content-Type", "application/octet-stream")
                self.send_header("Accept-Ranges", "bytes")
                self.send_header("Content-Length", str(length))
                if status == 206:
                    self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                with pkg.open("rb") as f:
                    f.seek(start)
                    left = length
                    while left > 0:
                        chunk = f.read(min(1024 * 1024, left))
                        if not chunk:
                            break
                        self.wfile.write(chunk)
                        left -= len(chunk)
                try:
                    self.wfile.flush()
                except Exception:
                    pass
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                pass
            except Exception as e:
                try:
                    self._send(500, {"ok": False, "message": str(e)})
                except Exception:
                    pass
            return
        if path in ("/api/wx/messages", "/api/wx/groups", "/api/wx/images"):
            if not self._require_admin():
                return
            if _chat_media is None:
                self._send(500, {"ok": False, "message": "chat_media unavailable"})
                return
            qs = self._qs()
            account = (qs.get("account_wxid") or qs.get("wxid") or [""])[0]
            try:
                limit = int((qs.get("limit") or ["100"])[0])
            except Exception:
                limit = 100
            try:
                if path == "/api/wx/messages":
                    rows = _chat_media.list_messages(DATA_DIR, account_wxid=account, limit=limit)
                elif path == "/api/wx/groups":
                    rows = _chat_media.list_group_events(DATA_DIR, account_wxid=account, limit=limit)
                else:
                    rows = _chat_media.list_images(DATA_DIR, account_wxid=account, limit=limit)
                self._send(200, {"ok": True, "rows": rows})
            except Exception as e:
                self._send(500, {"ok": False, "message": str(e)})
            return
        if path.startswith("/api/wx/media/"):
            tok = self.headers.get("X-Admin-Token") or (self._qs().get("token") or [""])[0]
            if not check_admin_token(tok):
                self._send(401, {"ok": False, "message": "请先登录"})
                return
            rel = unquote(path.split("/api/wx/media/", 1)[-1]).lstrip("/\\")
            if ".." in rel.replace("\\", "/").split("/"):
                self._send(400, {"ok": False, "message": "bad path"})
                return
            abs_path = (DATA_DIR / "media" / rel).resolve()
            root = (DATA_DIR / "media").resolve()
            if not str(abs_path).startswith(str(root)) or not abs_path.is_file():
                self._send(404, {"ok": False, "message": "not found"})
                return
            data = abs_path.read_bytes()
            ctype = "image/jpeg"
            if abs_path.suffix.lower() in (".png",):
                ctype = "image/png"
            elif abs_path.suffix.lower() in (".gif",):
                ctype = "image/gif"
            elif abs_path.suffix.lower() in (".webp",):
                ctype = "image/webp"
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "private, max-age=3600")
            self.end_headers()
            self.wfile.write(data)
            return

        if path == "/api/desktop/webrtc/ice-config":
            if not self._require_admin():
                return
            try:
                import webrtc_session as wrs
                self._send(200, wrs.ice_config())
            except Exception as e:
                self._send(500, {"ok": False, "message": str(e)})
            return
        if path in ("/", "/index.html"):
            # Bust CDN/browser cache — old admin JS left uploads stuck on "等待服务器确认".
            qs = self._qs()
            ab = str((qs.get("ab") or [""])[0] or "").strip()
            if ab != ADMIN_UI_BUILD:
                # Relative query redirect keeps /发财888/ when nginx strips the prefix
                # before proxying (absolute "/?ab=…" would land on the site portal).
                self.send_response(302)
                self.send_header("Location", f"?ab={ADMIN_UI_BUILD}")
                self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
                self.send_header("Pragma", "no-cache")
                self.send_header("CDN-Cache-Control", "no-store")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            html = HTML.replace("__ADMIN_UI_BUILD__", ADMIN_UI_BUILD)
            body = html.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
            self.send_header("Pragma", "no-cache")
            self.send_header("Expires", "0")
            self.send_header("CDN-Cache-Control", "no-store")
            self.send_header("Cloudflare-CDN-Cache-Control", "no-store")
            self.send_header("X-Admin-UI-Build", ADMIN_UI_BUILD)
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("X-Frame-Options", "DENY")
            self.end_headers()
            self.wfile.write(body)
            try:
                self.wfile.flush()
            except Exception:
                pass
            return
        if path == "/api/current-table":
            # Read-only live desk snapshot for 预测系统 — no admin token required.
            if not _current_tables:
                self._send(500, {"ok": False, "message": "current_table 模块未加载"})
                return
            qs = self._qs()
            cid = (qs.get("clientInstanceId") or qs.get("clientId") or [""])[0]
            uid = (qs.get("userId") or qs.get("accountHash") or [""])[0]
            self._send(200, _current_tables.get_current_table(
                client_instance_id=str(cid or ""),
                user_id=str(uid or ""),
            ))
            return
        if path == "/api/current-table/history":
            if not self._require_admin():
                return
            if not _current_tables:
                self._send(500, {"ok": False, "message": "current_table 模块未加载"})
                return
            qs = self._qs()
            self._send(200, _current_tables.get_shoe_history(
                source_id=str((qs.get("sourceId") or ["facai888"])[0] or "facai888"),
                table_id=str((qs.get("tableId") or [""])[0] or ""),
                shoe_id=str((qs.get("shoeId") or qs.get("bootNo") or [""])[0] or ""),
            ))
            return
        if path == "/api/current-table/shoe-history":
            # Simulation recovery reads the same durable, official WS events
            # that build the current-table road. The signed desktop client is
            # allowed to read this narrow table/shoe slice; it does not expose
            # admin data or any bet/order records.
            if not self._require_upload():
                return
            if not _current_tables:
                self._send(500, {"ok": False, "message": "current_table 模块未加载"})
                return
            qs = self._qs()
            self._send(200, _current_tables.get_shoe_history(
                source_id=str((qs.get("sourceId") or ["facai888"])[0] or "facai888"),
                table_id=str((qs.get("tableId") or [""])[0] or ""),
                shoe_id=str((qs.get("shoeId") or qs.get("bootNo") or [""])[0] or ""),
            ))
            return
        if path == "/api/overview":
            if not self._require_admin():
                return
            payload = {"ok": True, "online": list_online(), "ips": list_known_ips(), "policy": load_policy()}
            try:
                from analytics_versions import (
                    ANALYTICS_ALGORITHM_VERSION,
                    BIG_ROAD_ALGORITHM_VERSION,
                    DATA_SCHEMA_VERSION,
                    GIT_COMMIT,
                    PLAN_REPLAY_VERSION,
                )
                payload["versions"] = {
                    "gitCommit": GIT_COMMIT,
                    "dataSchemaVersion": DATA_SCHEMA_VERSION,
                    "analyticsAlgorithmVersion": ANALYTICS_ALGORITHM_VERSION,
                    "bigRoadAlgorithmVersion": BIG_ROAD_ALGORITHM_VERSION,
                    "planReplayVersion": PLAN_REPLAY_VERSION,
                }
            except Exception:
                pass
            self._send(200, payload)
            return
        if path == "/api/admin/release/status":
            if not self._require_admin():
                return
            try:
                import update_manifest as um
                seed = str(_env("FACAI888_PUBLISH_KEY_B64", default="") or "").strip()
                self._send(200, um.status(DATA_DIR, seed_b64=seed))
            except Exception as e:
                self._send(500, {"ok": False, "message": str(e)})
            return
        if path == "/api/logs":
            if not self._require_admin():
                return
            qs = self._qs()
            ip = (qs.get("ip") or [""])[0]
            cid = (qs.get("clientId") or [""])[0]
            limit = int((qs.get("limit") or ["200"])[0] or 200)
            if not ip and cid:
                with _lock:
                    meta = _online.get(safe_id(cid)) or {}
                ip = str(meta.get("ip") or "")
            rows = read_log(ip, limit) if ip else []
            self._send(200, {"ok": True, "ip": ip, "rows": rows})
            return
        if path == "/api/formula-stats":
            if not self._require_admin():
                return
            qs = self._qs()
            ip = (qs.get("ip") or [""])[0]
            cid = (qs.get("clientId") or [""])[0]
            stats = aggregate_formula_stats(ip=ip, client_id=cid)
            self._send(200, stats)
            return
        if path == "/api/client-detail":
            if not self._require_admin():
                return
            qs = self._qs()
            cid = (qs.get("clientId") or [""])[0]
            detail = build_client_detail(cid)
            self._send(200 if detail.get("ok") else 400, detail)
            return
        if path == "/api/road-overview":
            if not self._require_admin():
                return
            if not _road_archive:
                self._send(500, {"ok": False, "message": "road_archive 模块未加载"})
                return
            self._send(200, _road_archive.overview())
            return
        if path == "/api/road-boots/export":
            # Paginated full-boot export for 预测系统 local DuckDB sync.
            if not self._require_admin():
                return
            if not _road_archive:
                self._send(500, {"ok": False, "message": "road_archive 模块未加载"})
                return
            qs = self._qs()
            day_from = str((qs.get("dayFrom") or qs.get("from") or [""])[0] or "")
            day_to = str((qs.get("dayTo") or qs.get("to") or [""])[0] or "")
            cat = str((qs.get("cat") or [""])[0] or "")
            quality_filter = str((qs.get("qualityFilter") or ["ALL"])[0] or "ALL")
            try:
                table_id = int((qs.get("tableId") or ["0"])[0] or 0)
            except Exception:
                table_id = 0
            try:
                limit = int((qs.get("limit") or ["300"])[0] or 300)
            except Exception:
                limit = 300
            try:
                cursor = int((qs.get("cursor") or ["0"])[0] or 0)
            except Exception:
                cursor = 0
            limit = max(1, min(limit, 1000))
            cursor = max(0, cursor)
            boots = _road_archive.collect_boots(
                day_from=day_from,
                day_to=day_to,
                table_id=table_id,
                cat=cat,
                quality_filter=quality_filter,
                limit_boots=limit,
                offset=cursor,
            )
            items = []
            bead_count = 0
            for b in boots:
                seq = str(b.get("seq") or "")
                bead_count += len(seq)
                items.append({
                    "day": b.get("day"),
                    "tableId": b.get("tableId"),
                    "tableName": b.get("title") or "",
                    "bootNo": b.get("bootNo"),
                    "cat": b.get("cat") or "",
                    "seq": seq,
                    "pairs": b.get("pairs") or "",
                    "seqHash": b.get("seqHash") or "",
                    "qualityLevel": b.get("qualityLevel") or "",
                    "updatedAt": b.get("updatedAt") or 0,
                })
            next_cursor = cursor + len(items) if len(items) >= limit else None
            self._send(200, {
                "ok": True,
                "items": items,
                "count": len(items),
                "beadCount": bead_count,
                "cursor": cursor,
                "nextCursor": next_cursor,
                "dayFrom": day_from,
                "dayTo": day_to,
                "qualityFilter": quality_filter,
            })
            return
        if path == "/api/desktop/latest":
            if not self._require_admin():
                return
            cid = (self._qs().get("clientId") or [""])[0]
            shot = get_shot(cid)
            if not shot:
                self._send(200, {"ok": True, "message": "还没有画面", "image": ""})
                return
            online_meta = get_online_meta(cid) if cid else {}
            last_seen = float(online_meta.get("lastSeen") or 0)
            client_online = bool(last_seen and (now_ts() - last_seen) < float(ONLINE_TTL))
            self._send(200, {
                "ok": True,
                **shot,
                "clientOnline": client_online,
                "desktopWatching": bool(online_meta.get("desktopWatching")),
                "lastSeenText": online_meta.get("lastSeenText") or "",
            })
            return
        if path == "/api/agent/poll":
            if not self._require_upload():
                return
            qs = self._qs()
            cid, err = require_client_id((qs.get("clientId") or [""])[0])
            if err:
                self._send(400, err)
                return
            cmd = pop_command(cid)
            self._send(200, {"ok": True, "command": cmd, "policyEpoch": _policy_epoch()})
            return

        if path in ("/api/ws/agent", "/api/ws/viewer", "/api/ws/predictor"):
            self._upgrade_ws(path)
            return
        if path == "/api/run-permit":
            if not self._require_upload():
                return
            qs = self._qs()
            cid, err = require_client_id((qs.get("clientId") or [""])[0])
            if err:
                self._send(400, err)
                return
            ip = client_ip(self)
            permit = check_run_allowed(cid, ip)
            self._send(200, {"ok": True, "ip": ip, **permit})
            return
        self._send(404, {"ok": False, "message": "not found"})

    def _agent_upload_token(self) -> tuple[str, bool]:
        """Return (token, from_query_only). Agent must authenticate via Header."""
        auth = str(self.headers.get("Authorization") or "").strip()
        hdr = str(self.headers.get("X-Upload-Token") or "").strip()
        if auth.lower().startswith("bearer "):
            bearer = auth[7:].strip()
            if bearer:
                hdr = bearer
        qs_tok = str((self._qs().get("token") or [""])[0] or "").strip()
        if hdr:
            return hdr, False
        return qs_tok, True

    def _upgrade_ws(self, path: str) -> None:
        key = self.headers.get("Sec-WebSocket-Key")
        if not key:
            self._send(400, {"ok": False, "message": "缺少 WebSocket Key"})
            return
        qs = self._qs()
        if path.endswith("/predictor"):
            # Read-only live table push for 预测系统 — no admin login required.
            if _predictor_ws is None:
                self._send(500, {"ok": False, "message": "predictor_ws 模块未加载"})
                return
            role = "predictor"
            filter_cid = str((qs.get("clientInstanceId") or qs.get("clientId") or [""])[0] or "")
            filter_uid = str((qs.get("userId") or qs.get("accountHash") or [""])[0] or "")
            cid = ""
        elif path.endswith("/agent"):
            _tok, from_query = self._agent_upload_token()
            if from_query and _tok:
                self._send(401, {"ok": False, "message": "请使用 Header 认证（已停用 URL token）"})
                return
            try:
                import client_gate as cg
                meta = cg.require_client(
                    data_dir=DATA_DIR,
                    headers=self.headers,
                    method="WS_CONNECT",
                    path="/api/ws/agent",
                    body_raw=b"",
                    send=self._send,
                )
                if meta is None:
                    return
                self._client_meta = meta
            except Exception as e:
                self._send(500, {"ok": False, "message": str(e)})
                return
            cid_raw = (qs.get("clientId") or [""])[0]
            if str(cid_raw or "").strip().lower() == "unknown":
                self._send(400, {"ok": False, "message": "invalid_clientId"})
                return
            cid, _cerr = require_client_id(cid_raw) if str(cid_raw or "").strip() else (None, None)
            if cid is None:
                cid = ""
            role = "agent"
            filter_cid = ""
            filter_uid = ""
        else:
            cid, err = require_client_id((qs.get("clientId") or [""])[0])
            if err:
                self._send(400, err)
                return
            ticket = str((qs.get("ticket") or [""])[0] or "")
            if not consume_viewer_ticket(ticket, cid or ""):
                self._send(401, {"ok": False, "message": "查看凭证无效或已过期"})
                return
            role = "viewer"
            filter_cid = ""
            filter_uid = ""

        try:
            self.connection.sendall(handshake_response(key))
        except Exception:
            return
        sock = self.connection
        ip = client_ip(self)

        if role == "predictor":
            assert _predictor_ws is not None
            _predictor_ws.register_predictor(
                sock,
                client_instance_id=filter_cid,
                user_id=filter_uid,
            )
            try:
                send_json(sock, {
                    "type": "ready",
                    "role": "predictor",
                    "clientInstanceId": filter_cid or "",
                    "userId": filter_uid or "",
                    "all": not filter_cid and not filter_uid,
                    "message": "已连接当前桌推送通道；可用 subscribe 切换过滤",
                })
                if _current_tables and (filter_cid or filter_uid):
                    snap = _current_tables.get_current_table(
                        client_instance_id=filter_cid,
                        user_id=filter_uid,
                    )
                    if snap.get("found") and snap.get("current"):
                        send_json(sock, {
                            "type": "table_state",
                            "kind": "snapshot",
                            "t": now_iso(),
                            **snap["current"],
                        })
                while True:
                    msg = recv_json(sock, timeout=120)
                    if not isinstance(msg, dict):
                        continue
                    typ = str(msg.get("type") or "")
                    if typ == "ping":
                        send_json(sock, {"type": "pong", "t": now_iso()})
                    elif typ == "subscribe":
                        sub_cid = str(msg.get("clientInstanceId") or msg.get("clientId") or "")
                        sub_uid = str(msg.get("userId") or msg.get("accountHash") or "")
                        entry = _predictor_ws.update_subscription(
                            sock,
                            client_instance_id=sub_cid,
                            user_id=sub_uid,
                        )
                        send_json(sock, {
                            "type": "subscribed",
                            "clientInstanceId": (entry or {}).get("clientInstanceId") or "",
                            "userId": (entry or {}).get("userId") or "",
                            "all": bool((entry or {}).get("all")),
                        })
                        if _current_tables and (sub_cid or sub_uid):
                            snap = _current_tables.get_current_table(
                                client_instance_id=sub_cid,
                                user_id=sub_uid,
                            )
                            if snap.get("found") and snap.get("current"):
                                send_json(sock, {
                                    "type": "table_state",
                                    "kind": "snapshot",
                                    "t": now_iso(),
                                    **snap["current"],
                                })
                    elif typ == "unsubscribe":
                        _predictor_ws.update_subscription(sock, client_instance_id="", user_id="")
                        send_json(sock, {
                            "type": "subscribed",
                            "all": True,
                            "clientInstanceId": "",
                            "userId": "",
                        })
            except Exception:
                pass
            finally:
                _predictor_ws.unregister_predictor(sock)
                try:
                    sock.close()
                except Exception:
                    pass
            return

        if role == "agent":
            if cid:
                register_agent(cid, sock)
                touch_online({"clientId": cid, "ip": ip})
            try:
                while True:
                    msg = recv_json(sock, timeout=70)
                    if not isinstance(msg, dict):
                        continue
                    typ = str(msg.get("type") or "")
                    if typ == "hello":
                        hello_cid, herr = require_client_id(msg.get("clientId") or cid)
                        if herr:
                            try:
                                send_json(sock, {"type": "error", "message": herr.get("message")})
                            except Exception:
                                pass
                            continue
                        cid = hello_cid or cid
                        touch_online({
                            "clientId": cid,
                            "ip": ip,
                            "account": str(msg.get("account") or "")[:80],
                            "version": str(msg.get("version") or "")[:40],
                            "desktopWatching": bool(msg.get("desktopWatching")),
                            "capabilities": msg.get("capabilities") if isinstance(msg.get("capabilities"), dict) else {},
                            **online_runtime_fields(msg),
                        })
                        register_agent(cid, sock)
                        # Agent WS just (re)connected. If admin viewers are still open,
                        # restart capture — otherwise UI freezes on the last cached JPEG.
                        resume_desktop_if_viewers(cid)
                    elif typ == "heartbeat":
                        payload = msg.get("payload") if isinstance(msg.get("payload"), dict) else msg
                        hb_cid, _ = require_client_id(payload.get("clientId") or cid)
                        if hb_cid:
                            cid = hb_cid
                        if cid:
                            touch_online({
                                "clientId": cid,
                                "ip": ip,
                                "account": str(payload.get("account") or "")[:80],
                                "version": str(payload.get("version") or "")[:40],
                                "desktopWatching": bool(payload.get("desktopWatching")),
                                "capabilities": payload.get("capabilities") if isinstance(payload.get("capabilities"), dict) else {},
                                **online_runtime_fields(payload),
                            })
                        permit = check_run_allowed(cid, ip)
                        if not permit.get("allowed"):
                            send_json(sock, {
                                "type": "deny_run",
                                "commandType": "REVOKE_RUNTIME",
                                "message": permit.get("message"),
                                "policyEpoch": permit.get("policyEpoch") or 0,
                            })
                        else:
                            ann = take_ip_announce_for_client(ip, cid)
                            if ann:
                                send_json(sock, ann)
                        if cid:
                            cmd = pop_command(cid)
                            if cmd:
                                send_json(sock, cmd)
                        send_json(sock, {"type": "heartbeat_ack", "id": str(msg.get("id") or ""), "t": now_iso()})
                    elif typ == "command_ack":
                        if cid:
                            try:
                                import command_queue as cq
                                cq.ack(
                                    cid,
                                    str(msg.get("commandId") or msg.get("id") or ""),
                                    status=str(msg.get("status") or "APPLIED"),
                                    failure_reason=str(msg.get("failureReason") or "")[:200],
                                    client_ack_signature=str(msg.get("ackSignature") or "")[:200],
                                )
                            except Exception:
                                pass
                    elif typ == "ingest":
                        payload = msg.get("payload") if isinstance(msg.get("payload"), dict) else {}
                        rows = payload.get("events") or []
                        if isinstance(rows, list):
                            for r in rows:
                                if isinstance(r, dict):
                                    r.setdefault("clientId", cid)
                            append_log(ip, rows)
                    elif typ == "wx_sync":
                        payload = msg.get("payload") if isinstance(msg.get("payload"), dict) else {}
                        if cid:
                            save_wx_sync(cid, payload)
                    elif typ == "frame":
                        with _ws_lock:
                            viewers = len(_viewer_ws.get(cid) or [])
                        img = normalize_frame_image(str(msg.get("image") or ""))
                        if not img:
                            continue
                        # Always refresh latest shot cache. Do NOT stop_desktop here:
                        # admin may open viewer a moment after /api/desktop/start; an
                        # immediate stop leaves the UI stuck on a stale cached frame.
                        if cid:
                            save_shot(cid, img, already_normalized=True)
                            if viewers > 0:
                                push_to_viewers(cid, {
                                    "type": "frame",
                                    "clientId": cid,
                                    "t": str(msg.get("t") or now_iso()),
                                    "image": img,
                                    "seq": msg.get("seq"),
                                    "keySeq": msg.get("keySeq"),
                                    "w": msg.get("w"),
                                    "h": msg.get("h"),
                                })
                        # Stopping continuous capture is handled when the last viewer leaves.
                    elif typ == "frame_delta":
                        # Dirty-rect tiles: relay only; never compose into shot cache.
                        with _ws_lock:
                            viewers = len(_viewer_ws.get(cid) or [])
                        if not cid or viewers <= 0:
                            continue
                        delta = normalize_frame_delta(msg)
                        if not delta:
                            continue
                        delta["clientId"] = cid
                        push_to_viewers(cid, delta)
                    elif typ in ("webrtc_offer", "webrtc_ice", "webrtc_answer", "webrtc_stop", "webrtc_error", "file_result"):
                        if cid:
                            if typ in ("webrtc_offer", "webrtc_answer", "webrtc_error"):
                                try:
                                    line = (
                                        f"[webrtc] agent→viewers {typ} cid={cid[:12]} "
                                        f"sid={str(msg.get('desktopSessionId') or '')[:16]} "
                                        f"viewers={viewer_count(cid)} "
                                        f"msg={str(msg.get('message') or '')[:120]}\n"
                                    )
                                    print(line, end="", flush=True)
                                    (LOG_DIR / "webrtc.log").parent.mkdir(parents=True, exist_ok=True)
                                    with open(LOG_DIR / "webrtc.log", "a", encoding="utf-8") as wf:
                                        wf.write(line)
                                except Exception:
                                    pass
                            if typ != "webrtc_error":
                                push_to_viewers(cid, msg)
                    elif typ == "pong":
                        pass
                    elif typ == "request_token_refresh":
                        if cid:
                            try:
                                import webrtc_session as ws
                                sess = ws._active_session_for_device(cid)
                                if sess and sess.get("agentToken"):
                                    now = time.time()
                                    agent_issued = float(sess.get("agentTokenIssuedAt") or sess.get("issuedAt") or 0)
                                    if (now - agent_issued) > 3000:
                                        try:
                                            import livekit_session as lks
                                            if lks.livekit_enabled():
                                                pair = lks.issue_pair(cid)
                                                if pair.get("ok") and pair.get("agentToken"):
                                                    sess["agentToken"] = pair["agentToken"]
                                                    sess["agentTokenIssuedAt"] = now
                                        except Exception:
                                            pass
                                    send_json(sock, {
                                        "type": "token_refresh_ack",
                                        "agentToken": str(sess.get("agentToken") or ""),
                                        "expiresIn": 3600,
                                    })
                            except Exception:
                                pass
            except Exception:
                pass
            finally:
                if cid:
                    unregister_agent(cid, sock)
                try:
                    sock.close()
                except Exception:
                    pass
            return

        # viewer — 进房只注册；带 LiveKit 凭证的 start 由 watch(desktopSessionId) 下发
        # （空 start_desktop 会 livekit=0，与正式会话打架、引发推流端反复拆房）
        cancel_pending_stop_desktop(cid)
        register_viewer(cid, sock)
        try:
            send_json(sock, {"type": "ready", "clientId": cid})
            # LiveKit 已启用时不预灌缓存全图：墙/桌面会走媒体面，重连时省一轮大包
            send_cached = True
            try:
                import livekit_session as _lks

                if _lks.livekit_enabled():
                    send_cached = False
            except Exception:
                send_cached = True
            if send_cached:
                shot = get_shot(cid)
                if shot and shot.get("image"):
                    send_json(
                        sock,
                        {
                            "type": "frame",
                            "clientId": cid,
                            "t": shot.get("t") or "",
                            "image": shot["image"],
                            "cached": True,
                        },
                    )
            while True:
                # LiveKit 出画不走本 WS，长时间无业务消息属正常；超时发 ping 续命，勿掐观众连接
                try:
                    msg = recv_json(sock, timeout=45)
                except (TimeoutError, socket.timeout):
                    try:
                        send_frame(sock, 9, b"ping")
                    except Exception:
                        break
                    continue
                if not isinstance(msg, dict):
                    continue
                typ = str(msg.get("type") or "")
                if typ == "watch":
                    cancel_pending_stop_desktop(cid)
                    quality = str(msg.get("quality") or "auto")
                    sid = str(msg.get("desktopSessionId") or "")
                    if sid:
                        bind_viewer_desktop_session(sock, sid)
                    force = bool(msg.get("kick") or msg.get("forceRestart"))
                    # 无 sid 的硬拉只会启动空 WebRTC/堵 publisher；JPEG 软续命即可
                    if force and not sid:
                        force = False
                    with _online_lock:
                        caps = dict((_online.get(cid) or {}).get("capabilities") or {})
                        already_watching = bool((_online.get(cid) or {}).get("desktopWatching"))
                    livekit_on = False
                    try:
                        import livekit_session as _lks
                        livekit_on = bool(_lks.livekit_enabled())
                    except Exception:
                        livekit_on = False
                    # LiveKit 已启用时禁止空 sid start（agents 常不报 capabilities.webrtc，仍会 livekit=0 打架）
                    if not sid and (livekit_on or caps.get("webrtc") or caps.get("livekit")):
                        continue
                    # 已在推流且无新 sid：忽略重复软 watch，避免 ~2min 重连风暴
                    if not sid and already_watching and not force:
                        continue
                    ice_servers = None
                    protocol_version = ""
                    control_mouse = True
                    control_keyboard = True
                    livekit_url = ""
                    livekit_token = ""
                    room_name = ""
                    if sid:
                        try:
                            import webrtc_session as wrs
                            sess = wrs.get_session(sid) or {}
                            # 服务重启后旧 sid 失效：勿用空凭证 start（日志 ice=0 livekit=0）
                            if not sess:
                                continue
                            ice = sess.get("iceServers")
                            if isinstance(ice, list) and ice:
                                ice_servers = ice
                            protocol_version = str(sess.get("protocolVersion") or "desktop-livekit-v1")
                            perms = sess.get("permissions") or {}
                            if "CONTROL_MOUSE" in perms:
                                control_mouse = bool(perms.get("CONTROL_MOUSE"))
                            if "CONTROL_KEYBOARD" in perms:
                                control_keyboard = bool(perms.get("CONTROL_KEYBOARD"))
                            if not quality or quality == "auto":
                                quality = str(sess.get("quality") or quality or "auto")
                            if str(sess.get("transport") or "") == "livekit":
                                livekit_url = str(sess.get("livekitUrl") or "")
                                livekit_token = str(sess.get("agentToken") or "")
                                room_name = str(sess.get("roomName") or "")
                                if not (livekit_url and livekit_token):
                                    continue
                        except Exception:
                            continue
                    start_desktop_for_agent(
                        cid,
                        quality=quality,
                        session_id=sid,
                        force_restart=force,
                        ice_servers=ice_servers,
                        protocol_version=protocol_version,
                        control_mouse=control_mouse,
                        control_keyboard=control_keyboard,
                        livekit_url=livekit_url,
                        livekit_token=livekit_token,
                        room_name=room_name,
                    )
                elif typ == "ping":
                    try:
                        send_json(sock, {"type": "pong", "t": int(time.time())})
                    except Exception:
                        pass
                elif typ == "unwatch":
                    # Match disconnect debounce — brief unwatch/reconnect must not STOP then START.
                    schedule_stop_desktop_if_idle(cid, delay_sec=3.0)
                elif typ.startswith("webrtc_") or typ in ("control", "file"):
                    sid = str(msg.get("desktopSessionId") or "")
                    if sid and typ.startswith("webrtc_"):
                        bind_viewer_desktop_session(sock, sid)
                    if typ in ("webrtc_offer", "webrtc_answer"):
                        try:
                            line = (
                                f"[webrtc] viewer→agent {typ} cid={cid[:12]} "
                                f"sid={str(sid or '')[:16]}\n"
                            )
                            print(line, end="", flush=True)
                            with open(
                                os.path.join(DATA_DIR, "logs", "webrtc.log"),
                                "a",
                                encoding="utf-8",
                            ) as wf:
                                wf.write(line)
                        except Exception:
                            pass
                    tell_agent(cid, msg)
        except Exception:
            pass
        finally:
            unregister_viewer(cid, sock)
            # Debounced: brief reconnect must not kill publisher while UI reconnects.
            if viewer_count(cid) == 0:
                schedule_stop_desktop_if_idle(cid, delay_sec=2.0)
            try:
                sock.close()
            except Exception:
                pass


    def do_POST(self) -> None:  # noqa: N802
        if self._reject_legacy_siren():
            return
        path = self._strip_public_prefix(self._path())
        # Binary upload must NOT go through _read_json() — that would consume the
        # entire body first, then store_package_stream blocks forever re-reading it.
        if path == "/api/admin/release/upload":
            self._handle_release_upload()
            return
        if path == "/api/admin/release/upload/chunk":
            self._handle_release_upload_chunk()
            return
        if path == "/api/admin/release/upload/part":
            self._handle_release_upload_part()
            return
        body = self._read_json()

        if path == "/api/admin/ws-ticket":
            if not self._require_admin():
                return
            cid, err = require_client_id(str(body.get("clientId") or ""))
            if err:
                self._send(400, err)
                return
            self._send(200, {"ok": True, "ticket": make_viewer_ticket(cid or ""), "expiresIn": 30})
            return

        if path in ("/api/software-auth/register", "/api/software-auth/login"):
            try:
                import software_accounts as accounts
                fn = accounts.register if path.endswith("register") else accounts.login
                result = fn(DATA_DIR, body.get("username"), body.get("password"))
                self._send(200, {"ok": True, **result})
            except Exception as e:
                self._send(400, {"ok": False, "message": str(e)})
            return
        if path == "/api/software-auth/logout":
            try:
                import software_accounts as accounts
                auth = str(self.headers.get("Authorization") or "")
                accounts.logout(DATA_DIR, auth[7:].strip() if auth.lower().startswith("bearer ") else "")
                self._send(200, {"ok": True})
            except Exception as e:
                self._send(500, {"ok": False, "message": str(e)})
            return
        if path.startswith("/api/admin/software-accounts/"):
            if not self._require_admin():
                return
            try:
                import software_accounts as accounts
                account_id = str(body.get("id") or "").strip()
                if path.endswith("/status"):
                    accounts.set_status(DATA_DIR, account_id, bool(body.get("enabled")))
                elif path.endswith("/reset-password"):
                    accounts.reset_password(DATA_DIR, account_id, str(body.get("password") or ""))
                elif path.endswith("/delete"):
                    accounts.delete_account(DATA_DIR, account_id)
                else:
                    self._send(404, {"ok": False, "message": "功能不存在"}); return
                self._send(200, {"ok": True})
            except Exception as e:
                self._send(400, {"ok": False, "message": str(e)})
            return

        if path == "/api/admin/release/upload/init":
            if not self._require_admin():
                return
            try:
                import chunk_upload as cu
                row = body if isinstance(body, dict) else {}
                requested_chunk = row.get("chunkSize")
                try:
                    chunk_arg = int(requested_chunk) if requested_chunk not in (None, "") else None
                except Exception:
                    chunk_arg = None
                result = cu.begin_chunked_upload(
                    DATA_DIR,
                    str(row.get("buildId") or "").strip(),
                    str(row.get("fileName") or "").strip(),
                    int(row.get("fileSize") or 0),
                    chunk_size=chunk_arg,
                )
                self._send(200 if result.get("ok") else 400, result)
            except Exception as e:
                self._send(500, {"ok": False, "message": str(e)})
            return
        if path == "/api/admin/release/upload/finish":
            if not self._require_admin():
                return
            try:
                import chunk_upload as cu
                row = body if isinstance(body, dict) else {}
                result = cu.finish_chunked_upload(
                    DATA_DIR, str(row.get("buildId") or "").strip()
                )
                self._send(200 if result.get("ok") else 400, result)
            except Exception as e:
                self._send(500, {"ok": False, "message": str(e)})
            return
        if path == "/api/update/report":
            try:
                import update_manifest as um
                um.report_event(DATA_DIR, body if isinstance(body, dict) else {})
                self._send(200, {"ok": True})
            except Exception as e:
                self._send(500, {"ok": False, "message": str(e)})
            return
        if path == "/api/update/health":
            try:
                import update_manifest as um
                row = body if isinstance(body, dict) else {}
                row["event"] = "HEALTH_OK"
                um.report_event(DATA_DIR, row)
                self._send(200, {"ok": True})
            except Exception as e:
                self._send(500, {"ok": False, "message": str(e)})
            return
        if path == "/api/desktop/webrtc/session":
            if not self._require_admin():
                return
            try:
                cid = safe_id(str((body or {}).get("deviceId") or (body or {}).get("clientId") or ""))
                with _online_lock:
                    capabilities = dict((_online.get(cid) or {}).get("capabilities") or {})
                source = str((body or {}).get("source") or "desktop").lower()
                needed = "camera" if source == "camera" else "webrtc"
                livekit_on = False
                try:
                    import livekit_session as _lks
                    livekit_on = bool(_lks.livekit_enabled())
                except Exception:
                    livekit_on = False
                # 旧客户端常不报 capabilities.webrtc；LiveKit 已配置时仍允许建会话
                if needed == "webrtc" and not capabilities.get("webrtc") and not livekit_on:
                    self._send(409, {"ok": False, "message": "当前客户端使用稳定画面模式，该加速功能未启用"})
                    return
                if needed == "camera" and not capabilities.get("camera"):
                    self._send(409, {"ok": False, "message": "当前客户端使用稳定画面模式，该加速功能未启用"})
                    return
                import webrtc_session as wrs
                sess = wrs.create_session(body if isinstance(body, dict) else {})
                cid = str((body or {}).get("deviceId") or (body or {}).get("clientId") or "").strip()
                # deferStart：只发 sid/ICE，等 viewer 绑好 PC 后再用 watch 拉起代理（屏幕墙默认）
                defer_start = bool((body or {}).get("deferStart"))
                if sess.get("ok") and cid and not defer_start:
                    perms = sess.get("permissions") or {}
                    src = str((body or {}).get("source") or "desktop").strip().lower() or "desktop"
                    ice_servers = sess.get("iceServers") or []
                    # HTTP 响应当场剥掉 agentToken；下发代理须从内存会话再取
                    sid = str(sess.get("desktopSessionId") or "")
                    stored = wrs.get_session(sid) or {}
                    # 单次 coalesced 下发（含 iceServers / LiveKit），避免墙+后台连环 forceRestart
                    start_desktop_for_agent(
                        cid,
                        quality=str(sess.get("quality") or "auto"),
                        session_id=sid,
                        force_restart=True,
                        ice_servers=ice_servers if isinstance(ice_servers, list) else None,
                        protocol_version=str(sess.get("protocolVersion") or "desktop-livekit-v1"),
                        control_mouse=bool(perms.get("CONTROL_MOUSE")) and src != "camera",
                        control_keyboard=bool(perms.get("CONTROL_KEYBOARD")) and src != "camera",
                        livekit_url=str(stored.get("livekitUrl") or sess.get("livekitUrl") or ""),
                        livekit_token=str(stored.get("agentToken") or ""),
                        room_name=str(stored.get("roomName") or sess.get("roomName") or ""),
                    )
                self._send(200, sess)
            except Exception as e:
                self._send(500, {"ok": False, "message": str(e)})
            return
        if path == "/api/desktop/webrtc/stop":
            if not self._require_admin():
                return
            try:
                import webrtc_session as wrs
                self._send(200, wrs.stop_session(body if isinstance(body, dict) else {}))
            except Exception as e:
                self._send(500, {"ok": False, "message": str(e)})
            return
        if path == "/api/device/register":
            self._send(410, {
                "ok": False,
                "code": "CHALLENGE_REQUIRED",
                "message": "请使用 /api/device/register/challenge 与 /complete",
            })
            return
        if path == "/api/device/register/challenge":
            try:
                import devices as dev
                self._send(200, dev.begin_challenge(body if isinstance(body, dict) else {}, data_dir=DATA_DIR))
            except Exception as e:
                self._send(500, {"ok": False, "message": str(e)})
            return
        if path == "/api/device/register/complete":
            try:
                import devices as dev
                self._send(200, dev.complete_challenge(body if isinstance(body, dict) else {}, data_dir=DATA_DIR))
            except Exception as e:
                self._send(500, {"ok": False, "message": str(e)})
            return

        if path == "/api/login":
            ip = client_ip(self)
            try:
                import rate_limit as rl
                gate = rl.check_login_allowed(ip)
                if not gate.get("ok"):
                    self._send(429, {
                        "ok": False,
                        "message": gate.get("message") or "尝试过多，请稍后再试",
                        "retryAfterSec": gate.get("retryAfterSec") or 30,
                    })
                    return
            except Exception:
                pass
            if str(body.get("password") or "") != SITE_PASSWORD:
                try:
                    import rate_limit as rl
                    rl.record_login_failure(ip)
                except Exception:
                    pass
                try:
                    import security_audit as sa
                    sa.emit("admin_login_failed", reason_code="bad_password", detail={"ip": ip})
                except Exception:
                    pass
                self._send(401, {"ok": False, "message": "密码不对"})
                return
            try:
                import rate_limit as rl
                rl.record_login_success(ip)
            except Exception:
                pass
            try:
                import security_audit as sa
                sa.emit("admin_login_ok", detail={"ip": ip})
            except Exception:
                pass
            self._send(200, {"ok": True, "token": make_admin_token(), "ttlSec": TOKEN_TTL})
            return

        # ---- wxqk chat / group / image ingest ----
        if path in (
            "/api/wx/messages/ingest",
            "/api/wx/groups/ingest",
            "/api/wx/images/ingest",
            "/api/wx/images/delete",
            "/api/wx/images/cleanup",
        ):
            tok = self.headers.get("X-Admin-Token") or ""
            authed = check_admin_token(tok)
            if not authed:
                # Desktop agent path: device signature via client_gate.
                if not self._require_upload():
                    return
            elif path.startswith("/api/wx/images/") and path.endswith(("delete", "cleanup")):
                # cleanup/delete: admin only
                pass
            if path in ("/api/wx/images/delete", "/api/wx/images/cleanup") and not check_admin_token(tok):
                self._send(401, {"ok": False, "message": "请先登录"})
                return
            if _chat_media is None:
                self._send(500, {"ok": False, "message": "chat_media unavailable"})
                return
            try:
                if path == "/api/wx/messages/ingest":
                    self._send(200, _chat_media.ingest_message(DATA_DIR, body if isinstance(body, dict) else {}))
                elif path == "/api/wx/groups/ingest":
                    self._send(200, _chat_media.ingest_group_event(DATA_DIR, body if isinstance(body, dict) else {}))
                elif path == "/api/wx/images/ingest":
                    b64 = str((body or {}).get("data") or (body or {}).get("imageBase64") or "")
                    raw = base64.b64decode(b64) if b64 else b""
                    if not raw:
                        self._send(400, {"ok": False, "message": "empty image"})
                        return
                    self._send(
                        200,
                        _chat_media.ingest_image_bytes(
                            DATA_DIR,
                            account_wxid=str((body or {}).get("account_wxid") or ""),
                            session_id=str((body or {}).get("session_id") or ""),
                            session_name=str((body or {}).get("session_name") or ""),
                            raw=raw,
                            ext=str((body or {}).get("ext") or ".jpg"),
                        ),
                    )
                elif path == "/api/wx/images/delete":
                    self._send(200, _chat_media.delete_image(DATA_DIR, str((body or {}).get("id") or "")))
                else:
                    before = (body or {}).get("before_ts")
                    self._send(
                        200,
                        _chat_media.cleanup_images(
                            DATA_DIR,
                            account_wxid=str((body or {}).get("account_wxid") or ""),
                            before_ts=float(before) if before is not None and before != "" else None,
                        ),
                    )
            except Exception as e:
                self._send(500, {"ok": False, "message": str(e)})
            return

        if path == "/api/refresh":
            tok = self.headers.get("X-Admin-Token") or ""
            if not check_admin_token(tok):
                self._send(401, {"ok": False, "message": "请先登录"})
                return
            # Always mint a fresh token on explicit refresh.
            new_tok = make_admin_token()
            self._admin_token_renew = new_tok
            self._send(200, {"ok": True, "token": new_tok, "ttlSec": TOKEN_TTL})
            return

        if path == "/api/ingest":
            if not self._require_upload():
                return
            ip = client_ip(self)
            cid, err = require_client_id(body.get("clientId"))
            if err:
                self._send(400, err)
                return
            rows = body.get("events") or []
            if not isinstance(rows, list):
                rows = []
            for r in rows:
                if isinstance(r, dict):
                    r.setdefault("clientId", cid)
            n = append_log(ip, rows)
            summary = body.get("summary")
            if isinstance(summary, dict) and summary.get("text"):
                append_log(ip, [{"text": str(summary.get("text")), "kind": "汇总", "clientId": cid, "t": now_iso()}])
            touch_online(
                {
                    "clientId": cid,
                    "ip": ip,
                    "account": str(body.get("account") or "")[:40],
                    "version": str(body.get("version") or "")[:40],
                    "plan": str(body.get("plan") or "")[:80],
                }
            )
            self._send(200, {"ok": True, "accepted": n, "ip": ip})
            return

        if path == "/api/road-archive":
            if not self._require_upload():
                return
            if not _road_archive:
                self._send(500, {"ok": False, "message": "road_archive 模块未加载"})
                return
            ensure_dirs()
            cid, err = require_client_id(body.get("clientId"))
            if err:
                self._send(400, err)
                return
            account = str(body.get("account") or "")[:40]
            rows = body.get("rows") or body.get("events") or []
            if not isinstance(rows, list):
                rows = []
            result = _road_archive.ingest(rows, account=account, client_id=cid)
            touch_online({
                "clientId": cid,
                "ip": client_ip(self),
                "account": account,
                "version": str(body.get("version") or "")[:40],
                "plan": str(body.get("plan") or "")[:80],
            })
            self._send(200, result)
            return

        if path == "/api/table-state":
            if not self._require_upload():
                return
            if not _current_tables:
                self._send(500, {"ok": False, "message": "current_table 模块未加载"})
                return
            ensure_dirs()
            cid, err = require_client_id(body.get("clientInstanceId") or body.get("clientId"))
            if err:
                self._send(400, err)
                return
            payload = dict(body) if isinstance(body, dict) else {}
            payload["clientInstanceId"] = cid
            if not payload.get("userId") and payload.get("accountHash"):
                payload["userId"] = payload.get("accountHash")
            result = _current_tables.upsert_table_state(payload)
            if result.get("ok"):
                kind = str(payload.get("kind") or "state")
                if kind == "heartbeat":
                    notify_predictors("table_heartbeat", {
                        "clientInstanceId": cid,
                        "userId": str(payload.get("userId") or ""),
                        "tableId": str(payload.get("tableId") or ""),
                        "shoeId": str(payload.get("shoeId") or ""),
                        "roundId": str(payload.get("roundId") or payload.get("lastRoundId") or ""),
                        "lastSourceSequence": payload.get("lastSourceSequence") or payload.get("sourceSequence"),
                        "online": True,
                        "tableStatus": "ENTERED",
                        "kind": "heartbeat",
                    })
                else:
                    cur = None
                    try:
                        snap = _current_tables.get_current_table(client_instance_id=cid)
                        if snap.get("found"):
                            cur = snap.get("current")
                    except Exception:
                        cur = None
                    notify_predictors(
                        "table_state",
                        cur or {
                            "clientInstanceId": cid,
                            "userId": str(payload.get("userId") or ""),
                            "tableId": str(payload.get("tableId") or ""),
                            "shoeId": str(payload.get("shoeId") or ""),
                            "tableStatus": str(payload.get("tableStatus") or ""),
                            "online": bool(payload.get("online", True)),
                            "kind": kind,
                        },
                        kind=kind,
                    )
            self._send(200 if result.get("ok") else 400, result)
            return

        if path == "/api/round-event":
            if not self._require_upload():
                return
            if not _current_tables:
                self._send(500, {"ok": False, "message": "current_table 模块未加载"})
                return
            ensure_dirs()
            cid, err = require_client_id(body.get("clientInstanceId") or body.get("clientId"))
            if err:
                self._send(400, err)
                return
            payload = dict(body) if isinstance(body, dict) else {}
            payload["clientInstanceId"] = cid
            if not payload.get("userId") and payload.get("accountHash"):
                payload["userId"] = payload.get("accountHash")
            result = _current_tables.ingest_round_event(payload)
            if result.get("ok") and int(result.get("accepted") or 0) > 0:
                notify_predictors("round_event", {
                    "clientInstanceId": cid,
                    "userId": str(payload.get("userId") or ""),
                    "sourceId": str(payload.get("sourceId") or "facai888"),
                    "tableId": str(payload.get("tableId") or ""),
                    "tableName": str(payload.get("tableName") or "")[:80],
                    "shoeId": str(payload.get("shoeId") or payload.get("bootNo") or ""),
                    "roundId": str(payload.get("roundId") or ""),
                    "roundIndex": payload.get("roundIndex"),
                    "result": str(result.get("result") or payload.get("result") or ""),
                    "eventTime": str(payload.get("eventTime") or ""),
                    "sourceSequence": payload.get("sourceSequence"),
                    "venueRoundId": str(payload.get("venueRoundId") or ""),
                })
            self._send(200 if result.get("ok") else 400, result)
            return

        if path == "/api/sim-bets/ingest":
            if not self._require_upload():
                return
            if not _sim_bets:
                self._send(500, {"ok": False, "message": "sim_bets 模块未加载"})
                return
            ensure_dirs()
            cid, err = require_client_id(body.get("clientId"))
            if err:
                self._send(400, err)
                return
            account = str(body.get("account") or "")[:40]
            account_hash = str(body.get("accountHash") or "")[:64]
            summary = body.get("summary") if isinstance(body.get("summary"), dict) else None
            events = body.get("events") or body.get("rows") or []
            if not isinstance(events, list):
                events = []
            result = _sim_bets.ingest(
                client_id=cid,
                account=account,
                account_hash=account_hash,
                summary=summary,
                events=events,
            )
            touch_online({
                "clientId": cid,
                "ip": client_ip(self),
                "account": account,
                "version": str(body.get("version") or "")[:40],
                "plan": str(body.get("plan") or "")[:80],
            })
            self._send(200 if result.get("ok") else 400, result)
            return

        if path == "/api/sim-bets/summary":
            if not self._require_upload():
                return
            if not _sim_bets:
                self._send(500, {"ok": False, "message": "sim_bets 模块未加载"})
                return
            ensure_dirs()
            cid, err = require_client_id(body.get("clientId"))
            if err:
                self._send(400, err)
                return
            account_hash = str(body.get("accountHash") or "")[:64]
            result = _sim_bets.get_summary(cid, account_hash=account_hash)
            self._send(200, result)
            return

        if path == "/api/sim-bets/events":
            if not self._require_upload():
                return
            if not _sim_bets:
                self._send(500, {"ok": False, "message": "sim_bets 模块未加载"})
                return
            ensure_dirs()
            cid, err = require_client_id(body.get("clientId"))
            if err:
                self._send(400, err)
                return
            account_hash = str(body.get("accountHash") or "")[:64]
            result = _sim_bets.query_events(
                client_id=cid,
                account_hash=account_hash,
                session_id=str(body.get("sessionId") or ""),
                page=int(body.get("page") or 1) or 1,
                page_size=int(body.get("pageSize") or body.get("page_size") or 50) or 50,
            )
            self._send(200 if result.get("ok") else 400, result)
            return

        if path == "/api/formula-events":
            if not self._require_upload():
                return
            if _ingest_formula_events_db is None or _analytics_db is None:
                self._send(500, {"ok": False, "message": "analytics 模块未加载"})
                return
            ensure_dirs()
            cid, err = require_client_id(body.get("clientId"))
            if err:
                self._send(400, err)
                return
            events = body.get("events") or body.get("rows") or []
            if not isinstance(events, list):
                events = []
            ip = client_ip(self)
            prepared: list[dict[str, Any]] = []
            for ev in events:
                if isinstance(ev, dict):
                    ev = dict(ev)
                    ev.setdefault("clientId", cid)
                    ev.setdefault("accountHash", body.get("accountHash"))
                    ev.setdefault("maskedAccount", body.get("account"))
                    prepared.append(ev)
            try:
                result = _ingest_formula_events_db(prepared, ip=ip, source="live")
            except Exception as e:
                self._send(500, {"ok": False, "message": str(e)[:200], "received": len(prepared)})
                return
            # SQLite is authoritative. Append JSONL audit only after successful insert path.
            jsonl_failed = 0
            if result.get("ok") and int(result.get("inserted") or 0) >= 0:
                try:
                    ensure_dirs()
                    with _formula_lock:
                        with FORMULA_EVENTS.open("a", encoding="utf-8") as f:
                            for ev in prepared:
                                line = {
                                    "t": now_iso(),
                                    "ip": ip,
                                    "clientId": ev.get("clientId") or cid,
                                    "code": ev.get("code"),
                                    "formula": ev.get("formulaId") or ev.get("patternText") or ev.get("patternHash"),
                                    "patternHash": ev.get("patternHash"),
                                    "patternText": ev.get("patternText"),
                                    "slot": ev.get("slot"),
                                    "simulated": ev.get("simulated"),
                                    "gameResult": ev.get("gameResult"),
                                    "betTransactionId": ev.get("betTransactionId"),
                                    "betAmount": ev.get("betAmount"),
                                    "betSide": ev.get("betSide"),
                                    "tableId": ev.get("tableId"),
                                    "tableTitle": ev.get("tableTitle"),
                                    "eventId": ev.get("eventId"),
                                }
                                f.write(json.dumps(line, ensure_ascii=False) + "\n")
                        if prepared and _formula_rotator:
                            _formula_rotator.note_append(len(prepared))
                            _formula_rotator.maybe_rotate(FORMULA_EVENTS)
                except Exception as e:
                    jsonl_failed = len(prepared)
                    print(f"[analytics] formula-events JSONL audit failed: {e}", flush=True)
                    try:
                        _analytics_db.set_meta(
                            "formula_events_jsonl_fail_count",
                            str(int(_analytics_db.get_meta("formula_events_jsonl_fail_count") or "0") + 1),
                        )
                    except Exception:
                        pass
            if _finalize_formula_ingest_response is not None:
                result = _finalize_formula_ingest_response(result, jsonl_failed=jsonl_failed)
            else:
                result["jsonlFailed"] = jsonl_failed
            # SQLite success must not flip to fail because of JSONL (avoids client infinite retry).
            touch_online({
                "clientId": cid,
                "ip": ip,
                "account": str(body.get("account") or "")[:40],
                "version": str(body.get("version") or "")[:40],
                "plan": str(body.get("plan") or "")[:80],
            })
            self._send(200 if result.get("ok") else 400, result)
            return

        if path == "/api/road-formula-winrate":
            # Admin UI uses X-Admin-Token; desktop client uses device signature via _require_upload.
            tok_admin = self.headers.get("X-Admin-Token") or ""
            if check_admin_token(tok_admin):
                self._note_admin_token_renew(tok_admin)
            elif not self._require_upload():
                return
            if not _road_archive:
                self._send(500, {"ok": False, "message": "road_archive 模块未加载"})
                return
            pattern = str(body.get("pattern") or body.get("formula") or "")
            day_from = str(body.get("dayFrom") or body.get("from") or "")
            day_to = str(body.get("dayTo") or body.get("to") or "")
            bet_mode = str(body.get("betMode") or body.get("mode") or "follow")
            table_id = int(body.get("tableId") or 0) or 0
            cat = str(body.get("cat") or "")
            quality_filter = str(body.get("qualityFilter") or body.get("dataQualityFilter") or "AB")
            algo = str(body.get("algorithm") or "strict").strip().lower()
            include_heavy = bool(body.get("includeHeavy") or body.get("heavy") or False)
            plan = body.get("plan") if isinstance(body.get("plan"), dict) else None
            # Default: strict physical big-road. Legacy logical suffix kept for compatibility.
            if algo in ("legacy", "legacy-logical", "logical") or _strict_road_formula_winrate is None:
                stats = _road_archive.formula_stats(
                    pattern,
                    day_from=day_from,
                    day_to=day_to,
                    bet_mode=bet_mode,
                    table_id=table_id,
                    cat=cat,
                )
                stats["algorithm"] = "legacy-logical"
                self._send(200 if stats.get("ok") else 400, stats)
                return
            boots = _road_archive.collect_boots(
                day_from=day_from,
                day_to=day_to,
                table_id=table_id,
                cat=cat,
                quality_filter="ALL",
            )
            # Also count excluded for response when filter is AB — pull D separately lightly via JSON if needed
            stats = _strict_road_formula_winrate(
                boots,
                pattern=pattern,
                bet_mode=bet_mode,
                plan=plan,
                quality_filter=quality_filter,
                include_heavy=include_heavy,
            )
            if stats.get("ok"):
                stats["dataDayFrom"] = day_from
                stats["dataDayTo"] = day_to
                stats["bootCountScanned"] = stats.get("bootsScanned") or len(boots)
            self._send(200 if stats.get("ok") else 400, stats)
            return

        if path == "/api/heartbeat":
            if not self._require_upload():
                return
            ip = client_ip(self)
            cid, err = require_client_id(body.get("clientId"))
            if err:
                self._send(400, err)
                return
            # P0: never accept platform passwords from clients.
            touch_online(
                {
                    "clientId": cid,
                    "ip": ip,
                    "account": str(body.get("account") or "")[:80],
                    "version": str(body.get("version") or "")[:40],
                    "desktopWatching": bool(body.get("desktopWatching")),
                    **online_runtime_fields(body),
                }
            )
            cmd = pop_command(cid)
            if not cmd:
                cmd = take_ip_announce_for_client(ip, cid)
            permit = check_run_allowed(cid, ip)
            self._send(200, {
                "ok": True,
                "ip": ip,
                "command": cmd,
                "allowed": bool(permit.get("allowed")),
                "message": permit.get("message") or "",
                "policyEpoch": int(permit.get("policyEpoch") or 0),
            })
            return

        if path == "/api/commands/ack":
            if not self._require_upload():
                return
            cid, err = require_client_id(body.get("clientId"))
            if err:
                self._send(400, err)
                return
            try:
                import command_queue as cq
                result = cq.ack(
                    cid,
                    str(body.get("commandId") or body.get("id") or ""),
                    status=str(body.get("status") or "APPLIED"),
                    failure_reason=str(body.get("failureReason") or "")[:200],
                    client_ack_signature=str(body.get("ackSignature") or body.get("signature") or "")[:200],
                )
            except Exception as e:
                self._send(500, {"ok": False, "message": str(e)})
                return
            self._send(200 if result.get("ok") else 400, result)
            return

        if path == "/api/commands/pull":
            if not self._require_upload():
                return
            cid, err = require_client_id(body.get("clientId"))
            if err:
                self._send(400, err)
                return
            cmd = pop_command(cid)
            self._send(200, {"ok": True, "command": cmd, "policyEpoch": _policy_epoch()})
            return

        if path == "/api/announce":
            if not self._require_admin():
                return
            result = dispatch_announce(
                str(body.get("ip") or ""),
                str(body.get("clientId") or ""),
                str(body.get("text") or ""),
                str(body.get("title") or "公告"),
            )
            self._send(200 if result.get("ok") else 400, result)
            return

        if path == "/api/desktop/upload":
            self._send(410, {
                "ok": False,
                "code": "JPEG_DESKTOP_RETIRED",
                "message": "旧桌面协议已停用，请升级客户端。",
            })
            return

        if path == "/api/desktop/start-camera":
            self._send(410, {"ok": False, "code": "CAMERA_DISABLED", "message": "摄像头功能已关闭"})
            return

        if path == "/api/desktop/stop-camera":
            self._send(410, {"ok": False, "code": "CAMERA_DISABLED", "message": "摄像头功能已关闭"})
            return

        if path == "/api/desktop/start":
            if not self._require_admin():
                return
            cid, err = require_client_id(body.get("clientId"))
            if err:
                self._send(400, err)
                return
            cancel_pending_stop_desktop(cid)
            quality = str(body.get("quality") or "auto")
            sid = str(body.get("desktopSessionId") or "")
            force = bool(body.get("kick") or body.get("forceRestart"))
            if force and not sid:
                force = False
            ice_servers = None
            protocol_version = ""
            livekit_url = ""
            livekit_token = ""
            room_name = ""
            if sid:
                try:
                    import webrtc_session as wrs
                    sess = wrs.get_session(sid) or {}
                    ice = sess.get("iceServers")
                    if isinstance(ice, list) and ice:
                        ice_servers = ice
                    protocol_version = str(sess.get("protocolVersion") or "desktop-livekit-v1")
                    if not quality or quality == "auto":
                        quality = str(sess.get("quality") or quality or "auto")
                    if str(sess.get("transport") or "") == "livekit":
                        livekit_url = str(sess.get("livekitUrl") or "")
                        livekit_token = str(sess.get("agentToken") or "")
                        room_name = str(sess.get("roomName") or "")
                except Exception:
                    pass
            ok = start_desktop_for_agent(
                cid,
                quality=quality,
                session_id=sid,
                force_restart=force,
                ice_servers=ice_servers,
                protocol_version=protocol_version,
                livekit_url=livekit_url,
                livekit_token=livekit_token,
                room_name=room_name,
            )
            self._send(200, {"ok": True, "ws": ok})
            return

        if path == "/api/desktop/stop":
            if not self._require_admin():
                return
            cid, err = require_client_id(body.get("clientId"))
            if err:
                self._send(400, err)
                return
            cancel_pending_stop_desktop(cid)
            ok = tell_agent(cid, {"type": "stop_desktop"})
            set_command(cid, {"type": "stop_desktop"})
            with _desktop_start_lock:
                _desktop_start_meta.pop(cid, None)
            with _online_lock:
                if cid in _online:
                    _online[cid]["desktopWatching"] = False
            self._send(200, {"ok": True, "ws": ok})
            return

        if path == "/api/run-control":
            if not self._require_admin():
                return
            action = str(body.get("action") or "").strip()
            cid_raw = str(body.get("clientId") or "").strip()
            tip = safe_ip(body.get("ip") or "")
            reason = str(body.get("reason") or "服务暂不可用").strip()[:120] or "服务暂不可用"
            cid = ""
            if cid_raw:
                cid, cerr = require_client_id(cid_raw)
                if cerr and action in ("deny_client", "allow_client"):
                    self._send(400, cerr)
                    return
                if cerr:
                    cid = ""

            def _mut(pol: dict) -> None:
                if action == "global_deny":
                    pol["globalAllow"] = False
                elif action == "global_allow":
                    pol["globalAllow"] = True
                elif action == "deny_client" and cid:
                    pol.setdefault("denyClients", {})[cid] = reason
                elif action == "allow_client" and cid:
                    pol.setdefault("denyClients", {}).pop(cid, None)
                elif action == "deny_ip" and tip and tip != "unknown":
                    pol.setdefault("denyIps", {})[tip] = reason
                elif action == "allow_ip" and tip and tip != "unknown":
                    pol.setdefault("denyIps", {}).pop(tip, None)
                else:
                    raise ValueError("bad_action")

            try:
                pol, epoch = mutate_policy(_mut)
            except ValueError:
                self._send(400, {"ok": False, "message": "参数不对"})
                return
            except Exception as e:
                self._send(500, {"ok": False, "message": str(e)})
                return

            if action == "global_deny":
                push_revoke_to_online(message=reason, policy_epoch=epoch)
            elif action == "global_allow":
                push_allow_to_online(policy_epoch=epoch)
            elif action == "deny_client" and cid:
                msg = (pol.get("denyClients") or {}).get(cid) or reason
                set_command(cid, {"type": "deny_run", "message": msg, "action": "REVOKE_RUNTIME"})
                tell_agent(cid, {
                    "type": "deny_run",
                    "commandType": "REVOKE_RUNTIME",
                    "message": msg,
                    "policyEpoch": epoch,
                })
            elif action == "allow_client" and cid:
                set_command(cid, {"type": "allow_run", "action": "REFRESH_POLICY"})
                tell_agent(cid, {"type": "allow_run", "commandType": "REFRESH_POLICY", "policyEpoch": epoch})
            elif action == "deny_ip" and tip and tip != "unknown":
                for target in clients_by_ip(tip):
                    set_command(target, {"type": "deny_run", "message": reason, "action": "REVOKE_RUNTIME"})
                    tell_agent(target, {
                        "type": "deny_run",
                        "commandType": "REVOKE_RUNTIME",
                        "message": reason,
                        "policyEpoch": epoch,
                    })

            append_log(tip or "admin", [{
                "t": now_iso(),
                "text": f"管理员操作：{action} client={cid or '-'} ip={tip or '-'} epoch={epoch}",
                "kind": "管控",
                "clientId": cid,
            }])
            self._send(200, {"ok": True, "policy": pol, "policyEpoch": epoch})
            return

        if path == "/api/admin/release/publish":
            if not self._require_admin():
                return
            try:
                import update_manifest as um
                seed = str(_env("FACAI888_PUBLISH_KEY_B64", default="") or "").strip()
                targets = body.get("targetClientIds")
                if isinstance(targets, list) and any(str(x).strip() for x in targets):
                    self._send(200, um.publish_targeted_release(
                        DATA_DIR,
                        version=str(body.get("version") or "").strip(),
                        build_id=str(body.get("buildId") or "").strip(),
                        target_client_ids=[str(x).strip() for x in targets if str(x).strip()],
                        git_commit=str(body.get("gitCommit") or "").strip(),
                        mandatory=bool(body.get("mandatory", True)),
                        file_name=str(body.get("fileName") or "").strip(),
                        download_url=str(body.get("downloadURL") or "").strip(),
                        seed_b64=seed,
                        public_base_url=PUBLIC_BASE_URL,
                    ))
                else:
                    self._send(200, um.publish_release(
                        DATA_DIR,
                        version=str(body.get("version") or "").strip(),
                        build_id=str(body.get("buildId") or "").strip(),
                        git_commit=str(body.get("gitCommit") or "").strip(),
                        mandatory=bool(body.get("mandatory", True)),
                        file_name=str(body.get("fileName") or "").strip(),
                        download_url=str(body.get("downloadURL") or "").strip(),
                        seed_b64=seed,
                        public_base_url=PUBLIC_BASE_URL,
                    ))
            except Exception as e:
                self._send(500, {"ok": False, "message": str(e)})
            return

        if path == "/api/friend-diagnostic/report":
            # Client upload of redacted diagnostic result (no admin token; bound by device presence)
            result = save_friend_diagnostic(body if isinstance(body, dict) else {})
            code = 200 if result.get("ok") else 400
            self._send(code, result)
            return

        if path == "/api/admin/friend-diagnostic/enqueue":
            if not self._require_admin():
                return
            cid = safe_id(body.get("targetClientId") or body.get("clientId") or "")
            if not cid or cid == "unknown":
                self._send(400, {"ok": False, "message": "targetClientId required"})
                return
            diagnostic_id = str(body.get("diagnosticId") or secrets.token_hex(8))
            expires_at = str(body.get("expiresAt") or "").strip()
            if not expires_at:
                from datetime import datetime, timedelta, timezone
                expires_at = (datetime.now(timezone.utc) + timedelta(minutes=10)).strftime("%Y-%m-%dT%H:%M:%SZ")
            payload = {
                "diagnosticId": diagnostic_id,
                "targetClientId": cid,
                "targetInstanceId": str(body.get("targetInstanceId") or ""),
                "targetAccountWxid": str(body.get("targetAccountWxid") or ""),
                "roomId": str(body.get("roomId") or ""),
                "memberUserName": str(body.get("memberUserName") or ""),
                "expectedNickname": str(body.get("expectedNickname") or ""),
                "dryRun": bool(body.get("dryRun", True)),
                "allowSingleAddFriendAfterVerified": bool(body.get("allowSingleAddFriendAfterVerified", False)),
                "expiresAt": expires_at,
                "idempotencyKey": str(body.get("idempotencyKey") or f"friend-probe-{diagnostic_id}"),
            }
            import command_queue as cq
            enq = cq.enqueue(cid, "FRIEND_CREDENTIAL_DIAGNOSTIC", payload, policy_epoch=_policy_epoch(), ttl_sec=600)
            cmd_id = str(enq.get("commandId") or "")
            tell_agent(cid, {
                "type": "friend_credential_diagnostic",
                "commandType": "FRIEND_CREDENTIAL_DIAGNOSTIC",
                "commandId": cmd_id,
                "id": cmd_id,
                **payload,
            })
            self._send(200, {"ok": True, "diagnosticId": diagnostic_id, "clientId": cid, "commandId": cmd_id, "payload": payload})
            return

        if path == "/api/admin/friend-diagnostic/force-update":
            if not self._require_admin():
                return
            cid = safe_id(body.get("targetClientId") or body.get("clientId") or "")
            if not cid or cid == "unknown":
                self._send(400, {"ok": False, "message": "targetClientId required"})
                return
            import command_queue as cq
            enq = cq.enqueue(cid, "CHECK_CLIENT_UPDATE", {"reason": str(body.get("reason") or "targeted_diagnostic")}, policy_epoch=_policy_epoch(), ttl_sec=600)
            cmd_id = str(enq.get("commandId") or "")
            tell_agent(cid, {
                "type": "check_client_update",
                "commandType": "CHECK_CLIENT_UPDATE",
                "commandId": cmd_id,
                "id": cmd_id,
                "reason": str(body.get("reason") or "targeted_diagnostic"),
            })
            self._send(200, {"ok": True, "clientId": cid, "commandId": cmd_id})
            return

        self._send(404, {"ok": False, "message": "not found"})


def require_client_id(raw: Any) -> tuple[str | None, dict[str, Any] | None]:
    """Reject empty / unknown clientId (safe_id must not coerce attackers to 'unknown')."""
    text = str(raw if raw is not None else "").strip()
    if not text:
        return None, {"ok": False, "message": "missing_clientId"}
    cid = safe_id(text)
    if not cid or cid.lower() == "unknown":
        return None, {"ok": False, "message": "invalid_clientId"}
    return cid, None


def _run_security_retention_once() -> None:
    """Hourly light prune for device_commands + security_audit (never per-request)."""
    try:
        import command_queue as cq
        import security_audit as sa
        out_cmd = cq.prune_terminal_commands()
        out_audit = sa.prune_security_audit()
        print(
            f"[security-retention] commands_deleted={out_cmd.get('deleted', 0)} "
            f"audit_deleted={out_audit.get('deleted', 0)}",
            flush=True,
        )
    except Exception as e:  # pragma: no cover
        print(f"[security-retention] failed: {e}", flush=True)


def start_security_retention_timer(*, interval_sec: float = 3600.0) -> None:
    """Daemon timer: first run after 60s, then every interval_sec (default 1h)."""

    def _loop() -> None:
        time.sleep(60.0)
        while True:
            _run_security_retention_once()
            time.sleep(max(300.0, float(interval_sec)))

    t = threading.Thread(target=_loop, name="security-retention", daemon=True)
    t.start()


def main() -> None:
    if not SITE_PASSWORD:
        raise SystemExit(
            "FACAI888_PASSWORD (or SIREN_PASSWORD) must be set"
            "(no hardcoded defaults)."
        )
    ensure_dirs()
    init_analytics_migrate()
    load_policy(force=True)
    start_security_retention_timer(interval_sec=3600.0)
    try:
        from analytics_versions import (
            ANALYTICS_ALGORITHM_VERSION,
            BIG_ROAD_ALGORITHM_VERSION,
            DATA_SCHEMA_VERSION,
            GIT_COMMIT,
            PLAN_REPLAY_VERSION,
        )
        dbp = ""
        if _analytics_db is not None:
            p = _analytics_db.db_path()
            dbp = str(p) if p else ""
        mig = ""
        if _analytics_db is not None:
            mig = (
                f"formula={_analytics_db.get_meta('formula_events_migrated') or '0'} "
                f"roads={_analytics_db.get_meta('roads_migrated') or '0'}"
            )
        print(
            f"[发财888] gitCommit={GIT_COMMIT} dataSchemaVersion={DATA_SCHEMA_VERSION} "
            f"analyticsAlgorithmVersion={ANALYTICS_ALGORITHM_VERSION} "
            f"bigRoadAlgorithmVersion={BIG_ROAD_ALGORITHM_VERSION} "
            f"planReplayVersion={PLAN_REPLAY_VERSION} databasePath={dbp} migrationStatus={mig}",
            flush=True,
        )
    except Exception as e:
        print(f"[analytics] version banner failed: {e}", flush=True)
    httpd = ThreadingHTTPServer((BIND, PORT), Handler)
    httpd.request_queue_size = 128
    print(f"[发财888] listening on {BIND}:{PORT}", flush=True)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
