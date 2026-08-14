# -*- coding: utf-8 -*-
"""Build / protocol version policy for 发财888 — fail-closed by default."""
from __future__ import annotations

import json
import os
import re
import threading
from pathlib import Path
from typing import Any

_lock = threading.RLock()

DEFAULT = {
    "minimumVersion": "0.0.0",
    "minimumBuildId": "",
    "minimumReleaseSequence": 1,
    "latestReleaseSequence": 0,
    "allowedBuildIds": [],  # empty = VERSION_POLICY_NOT_READY (not allow-all)
    "revokedBuildIds": [],
    "protocolVersion": "facai888-v1",
    "securityProtocolVersion": "security-v1",
    # Legacy protocol identifier only. No WebRTC implementation remains.
    # Clients still send desktop-webrtc-v1 for gate compatibility; meshcentral-v1 also accepted.
    "desktopProtocolVersion": "desktop-webrtc-v1",
    "updaterProtocolVersion": "updater-v1",
    "latestVersion": "0.0.0",
    "latestBuildId": "",
    "releaseChannel": "stable",
    "legacyUploadTokenRetired": True,
    "oldClientsAllowed": False,
    "jpegDesktopUploadRetired": True,
    "failClosed": True,
    "policyCacheTtlSec": 24 * 3600,
}


def security_mode() -> str:
    """strict (default) | test — test only via server env, never client param."""
    return str(os.environ.get("FACAI888_SECURITY_MODE") or "strict").strip().lower()


def policy_path(data_dir: Path) -> Path:
    return Path(data_dir) / "version_policy.json"


def load(data_dir: Path) -> dict[str, Any]:
    path = policy_path(data_dir)
    with _lock:
        if not path.exists():
            return dict(DEFAULT)
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
            out = dict(DEFAULT)
            if isinstance(raw, dict):
                out.update(raw)
            return out
        except Exception:
            # Corrupted policy → fail-closed empty allow list
            bad = dict(DEFAULT)
            bad["allowedBuildIds"] = []
            bad["_corrupt"] = True
            return bad


def save(data_dir: Path, pol: dict[str, Any]) -> None:
    path = policy_path(data_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    with _lock:
        tmp.write_text(json.dumps(pol, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(path)


def allow_build_id(data_dir: Path, build_id: str) -> bool:
    """Ensure an EXE-stamped buildId can pass the gate.

    Publish packages often use a server-side buildId that differs from the
    -ldflags BuildID baked into the client binary. Without this, registered
    devices authenticate once then fail every heartbeat → empty admin online.
    """
    bid = str(build_id or "").strip()
    if not bid or bid.lower() in ("unknown", "null", "none"):
        return False
    with _lock:
        pol = load(data_dir)
        allowed = [str(x) for x in (pol.get("allowedBuildIds") or [])]
        if bid in allowed:
            return False
        allowed.append(bid)
        pol["allowedBuildIds"] = allowed
        save(data_dir, pol)
        return True


_SEMVER_RE = re.compile(r"^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$")


def parse_semver(v: str) -> tuple[int, int, int] | None:
    m = _SEMVER_RE.match(str(v or "").strip())
    if not m:
        return None
    return int(m.group(1)), int(m.group(2)), int(m.group(3))


def semver_gte(got: str, minimum: str) -> bool:
    a = parse_semver(got)
    b = parse_semver(minimum)
    if a is None or b is None:
        return False
    return a >= b


def evaluate_client(meta: dict[str, Any], pol: dict[str, Any] | None = None, data_dir: Path | None = None) -> dict[str, Any]:
    """Return {ok, httpStatus, code, message, ...}. Fail-closed."""
    if pol is None:
        if data_dir is None:
            raise ValueError("data_dir or pol required")
        pol = load(data_dir)

    if pol.get("_corrupt") and pol.get("failClosed", True):
        return {
            "ok": False,
            "httpStatus": 503,
            "code": "VERSION_POLICY_CORRUPT",
            "message": "版本策略不可用。",
        }

    build = str(meta.get("buildId") or "").strip()
    version = str(meta.get("version") or "").strip()
    try:
        rel_seq = int(meta.get("releaseSequence") or 0)
    except Exception:
        rel_seq = 0
    proto = str(meta.get("protocolVersion") or "").strip()
    sec = str(meta.get("securityProtocolVersion") or "").strip()
    desk = str(meta.get("desktopProtocolVersion") or "").strip()
    upd = str(meta.get("updaterProtocolVersion") or "").strip()

    revoked = {str(x) for x in (pol.get("revokedBuildIds") or [])}
    allowed = [str(x) for x in (pol.get("allowedBuildIds") or [])]
    min_build = str(pol.get("minimumBuildId") or "").strip()
    try:
        min_seq = int(pol.get("minimumReleaseSequence") or 0)
    except Exception:
        min_seq = 0

    mode = security_mode()
    if mode == "test" and not allowed:
        # Local unit tests only: allow any non-revoked when list empty.
        pass
    elif not allowed:
        return {
            "ok": False,
            "httpStatus": 503,
            "code": "VERSION_POLICY_NOT_READY",
            "message": "版本策略未就绪。",
            "minimumReleaseSequence": min_seq,
        }

    if not build:
        return {
            "ok": False,
            "httpStatus": 426,
            "code": "CLIENT_UPGRADE_REQUIRED",
            "message": "当前版本已停止使用。",
            "minimumVersion": pol.get("minimumVersion"),
            "minimumBuildId": min_build,
            "minimumReleaseSequence": min_seq,
        }
    if build in revoked:
        return {
            "ok": False,
            "httpStatus": 403,
            "code": "BUILD_REVOKED",
            "message": "当前版本已停止使用。",
        }
    if mode != "test" and allowed and build not in allowed:
        return {
            "ok": False,
            "httpStatus": 426,
            "code": "CLIENT_UPGRADE_REQUIRED",
            "message": "当前版本已停止使用。",
            "minimumVersion": pol.get("minimumVersion"),
            "minimumBuildId": min_build or (allowed[0] if allowed else ""),
            "minimumReleaseSequence": min_seq,
        }
    if min_seq > 0 and rel_seq < min_seq:
        return {
            "ok": False,
            "httpStatus": 426,
            "code": "CLIENT_UPGRADE_REQUIRED",
            "message": "当前版本已停止使用。",
            "minimumReleaseSequence": min_seq,
        }
    min_ver = str(pol.get("minimumVersion") or "").strip()
    if min_ver and min_ver != "0.0.0" and version and not semver_gte(version, min_ver):
        return {
            "ok": False,
            "httpStatus": 426,
            "code": "CLIENT_UPGRADE_REQUIRED",
            "message": "当前版本已停止使用。",
            "minimumVersion": min_ver,
        }

    # Protocol fields: accept legacy + neutral IDs (client rebrand)
    protocol_compat = {
        "protocolVersion": frozenset({"facai888-v1", "app-v1"}),
        "securityProtocolVersion": frozenset({"security-v1", "sec-v1"}),
        "desktopProtocolVersion": frozenset({"desktop-webrtc-v1", "desk-v1", "meshcentral-v1"}),
        "updaterProtocolVersion": frozenset({"updater-v1", "upd-v1", "updater-v2", "upd-v2"}),
    }
    expect = [
        ("protocolVersion", proto, pol.get("protocolVersion")),
        ("securityProtocolVersion", sec, pol.get("securityProtocolVersion")),
        ("desktopProtocolVersion", desk, pol.get("desktopProtocolVersion")),
        ("updaterProtocolVersion", upd, pol.get("updaterProtocolVersion")),
    ]
    for name, got, want in expect:
        if not got:
            return {
                "ok": False,
                "httpStatus": 426,
                "code": "CLIENT_UPGRADE_REQUIRED",
                "message": "当前版本已停止使用。",
            }
        allowed = protocol_compat.get(name)
        if allowed:
            if got not in allowed:
                return {
                    "ok": False,
                    "httpStatus": 403,
                    "code": "PROTOCOL_RETIRED",
                    "message": "当前版本已停止使用。",
                }
            continue
        if want and got != want:
            return {
                "ok": False,
                "httpStatus": 403,
                "code": "PROTOCOL_RETIRED",
                "message": "当前版本已停止使用。",
            }

    return {
        "ok": True,
        "code": "OK",
        "message": "allowed",
        "policy": {
            "minimumBuildId": min_build,
            "latestBuildId": pol.get("latestBuildId"),
            "minimumReleaseSequence": min_seq,
            "latestReleaseSequence": pol.get("latestReleaseSequence"),
            "protocolVersion": pol.get("protocolVersion"),
        },
    }
