# -*- coding: utf-8 -*-
"""Device registry with challenge-response enrollment."""
from __future__ import annotations

import base64
import hashlib
import json
import os
import secrets
import threading
import time
from pathlib import Path
from typing import Any

_lock = threading.RLock()

STATUS_PENDING = "PENDING"
STATUS_ACTIVE = "ACTIVE"
STATUS_SUSPENDED = "SUSPENDED"
STATUS_REVOKED = "REVOKED"


def _path(data_dir: Path) -> Path:
    root = Path(data_dir) / "security"
    root.mkdir(parents=True, exist_ok=True)
    return root / "devices.json"


def _challenge_path(data_dir: Path) -> Path:
    root = Path(data_dir) / "security"
    root.mkdir(parents=True, exist_ok=True)
    return root / "device_challenges.json"


def _load(data_dir: Path) -> dict[str, Any]:
    p = _path(data_dir)
    if not p.exists():
        return {"devices": {}}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return {"devices": {}}


def _save(data_dir: Path, data: dict[str, Any]) -> None:
    p = _path(data_dir)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(p)


def _load_challenges(data_dir: Path) -> dict[str, Any]:
    p = _challenge_path(data_dir)
    if not p.exists():
        return {"challenges": {}}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return {"challenges": {}}


def _save_challenges(data_dir: Path, data: dict[str, Any]) -> None:
    p = _challenge_path(data_dir)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(p)


def device_id_from_pubkey_b64(pub_b64: str) -> str:
    raw = base64.b64decode(pub_b64)
    return hashlib.sha256(raw).hexdigest()


def begin_challenge(body: dict[str, Any], data_dir: Path | None = None) -> dict[str, Any]:
    dd = data_dir or Path(os.environ.get("FACAI888_DATA") or "/opt/facai888/data")
    pub = str(body.get("publicKey") or "").strip()
    build_id = str(body.get("buildId") or "").strip()
    if not pub:
        return {"ok": False, "message": "missing_public_key"}
    try:
        base64.b64decode(pub)
    except Exception:
        return {"ok": False, "message": "bad_public_key"}
    device_id = device_id_from_pubkey_b64(pub)
    with _lock:
        data = _load(dd)
        prev = (data.get("devices") or {}).get(device_id)
        if prev and str(prev.get("publicKey") or "") and str(prev.get("publicKey")) != pub:
            return {"ok": False, "code": "DEVICE_KEY_MISMATCH", "message": "公钥不可覆盖，请走管理端轮换"}
        challenge = secrets.token_hex(32)
        challenge_id = secrets.token_hex(12)
        ch = _load_challenges(dd)
        ch.setdefault("challenges", {})[challenge_id] = {
            "challengeId": challenge_id,
            "challengeHash": hashlib.sha256(challenge.encode()).hexdigest(),
            "publicKey": pub,
            "deviceId": device_id,
            "buildId": build_id,
            "expiresAt": time.time() + 300,
        }
        # prune expired
        now = time.time()
        ch["challenges"] = {
            k: v for k, v in ch["challenges"].items()
            if float(v.get("expiresAt") or 0) > now
        }
        _save_challenges(dd, ch)
    # Keep EXE-stamped buildId on the allow list (may differ from package buildId).
    if build_id:
        try:
            import version_policy as vp
            vp.allow_build_id(dd, build_id)
        except Exception:
            pass
    return {
        "ok": True,
        "challengeId": challenge_id,
        "challenge": challenge,
        "deviceId": device_id,
        "expiresInSec": 300,
    }


def complete_challenge(body: dict[str, Any], data_dir: Path | None = None) -> dict[str, Any]:
    dd = data_dir or Path(os.environ.get("FACAI888_DATA") or "/opt/facai888/data")
    challenge_id = str(body.get("challengeId") or "").strip()
    pub = str(body.get("publicKey") or "").strip()
    sig_b64 = str(body.get("signature") or "").strip()
    if not challenge_id or not pub or not sig_b64:
        return {"ok": False, "message": "missing_fields"}
    with _lock:
        ch_store = _load_challenges(dd)
        row = (ch_store.get("challenges") or {}).pop(challenge_id, None)
        _save_challenges(dd, ch_store)
        if not row:
            return {"ok": False, "code": "CHALLENGE_INVALID", "message": "challenge无效"}
        if float(row.get("expiresAt") or 0) < time.time():
            return {"ok": False, "code": "CHALLENGE_EXPIRED", "message": "challenge过期"}
        if str(row.get("publicKey")) != pub:
            return {"ok": False, "message": "public_key_mismatch"}
        # Verify Ed25519(sig, challenge) — challenge string is returned once; client signs it.
        # We only stored hash; client must also echo challenge in complete OR we keep plaintext briefly.
        # Prefer: client signs challengeId||publicKey; for P0 require challengeEcho.
        challenge_echo = str(body.get("challenge") or "").strip()
        if not challenge_echo or hashlib.sha256(challenge_echo.encode()).hexdigest() != row.get("challengeHash"):
            return {"ok": False, "code": "CHALLENGE_MISMATCH", "message": "challenge不匹配"}
        try:
            from nacl.signing import VerifyKey  # type: ignore
            from nacl.exceptions import BadSignatureError  # type: ignore
            vk = VerifyKey(base64.b64decode(pub))
            vk.verify(challenge_echo.encode(), base64.b64decode(sig_b64))
        except ImportError:
            # Fallback: use cryptography or pure ed25519 via hashlib only unavailable —
            # use Python 3.11+ or cryptography library if present.
            try:
                from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
                from cryptography.exceptions import InvalidSignature
                key = Ed25519PublicKey.from_public_bytes(base64.b64decode(pub))
                key.verify(base64.b64decode(sig_b64), challenge_echo.encode())
            except Exception as e:
                return {"ok": False, "code": "SIGNATURE_INVALID", "message": str(e)}
        except Exception as e:
            return {"ok": False, "code": "SIGNATURE_INVALID", "message": str(e)}

        device_id = str(row.get("deviceId"))
        data = _load(dd)
        devices = data.setdefault("devices", {})
        prev = devices.get(device_id) or {}
        # Invite code auto-activate for owned fleets
        invite = str(os.environ.get("FACAI888_DEVICE_INVITE") or "").strip()
        provided_invite = str(body.get("inviteCode") or "").strip()
        status = prev.get("status") or STATUS_PENDING
        if invite and provided_invite and secrets.compare_digest(invite, provided_invite):
            status = STATUS_ACTIVE
        elif status == STATUS_PENDING and os.environ.get("FACAI888_AUTO_ACTIVATE_DEVICES") == "1":
            status = STATUS_ACTIVE
        build_id = str(row.get("buildId") or prev.get("buildId") or "")
        devices[device_id] = {
            "deviceId": device_id,
            "publicKey": pub,
            "buildId": build_id,
            "status": status,
            "registeredAt": prev.get("registeredAt") or time.time(),
            "lastSeen": time.time(),
        }
        _save(dd, data)
    if build_id:
        try:
            import version_policy as vp
            vp.allow_build_id(dd, build_id)
        except Exception:
            pass
    return {"ok": True, "deviceId": device_id, "status": status}


def get_device(device_id: str, data_dir: Path | None = None) -> dict[str, Any] | None:
    dd = data_dir or Path(os.environ.get("FACAI888_DATA") or "/opt/facai888/data")
    with _lock:
        data = _load(dd)
        return (data.get("devices") or {}).get(str(device_id).strip())


def touch_device(device_id: str, data_dir: Path | None = None) -> None:
    dd = data_dir or Path(os.environ.get("FACAI888_DATA") or "/opt/facai888/data")
    with _lock:
        data = _load(dd)
        d = (data.get("devices") or {}).get(str(device_id).strip())
        if not d:
            return
        d["lastSeen"] = time.time()
        _save(dd, data)


# Backward-compat shim — rejects direct register without challenge.
def register_device(body: dict[str, Any], data_dir: Path | None = None) -> dict[str, Any]:
    return {
        "ok": False,
        "code": "CHALLENGE_REQUIRED",
        "message": "请使用 /api/device/register/challenge 与 /complete",
        "httpStatus": 410,
    }
