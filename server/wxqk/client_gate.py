# -*- coding: utf-8 -*-
"""Unified client gate: version policy + device signature (no shared upload token)."""
from __future__ import annotations

import base64
import hashlib
import hmac
import time
from pathlib import Path
from typing import Any, Callable

import device_auth
import devices as dev
import version_policy as vp


def body_sha256(raw: bytes | None) -> str:
    return hashlib.sha256(raw or b"").hexdigest()


def sign_message(method: str, path: str, body_hash: str, ts: int, nonce: str, build_id: str, release_seq: str, device_id: str) -> bytes:
    msg = f"{method}\n{path}\n{body_hash}\n{ts}\n{nonce}\n{build_id}\n{release_seq}\n{device_id}"
    return msg.encode("utf-8")


def verify_ed25519(pub_b64: str, message: bytes, sig_b64: str) -> bool:
    try:
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
        key = Ed25519PublicKey.from_public_bytes(base64.b64decode(pub_b64))
        key.verify(base64.b64decode(sig_b64), message)
        return True
    except Exception:
        return False


def require_client(
    *,
    data_dir: Path,
    headers: Any,
    method: str,
    path: str,
    body_raw: bytes | None,
    send: Callable[[int, dict], None],
    require_active_device: bool = True,
) -> dict[str, Any] | None:
    """
    Returns meta dict on success, or None after sending error via send(status, body).
    """
    meta = {
        "buildId": str(headers.get("X-Build-Id") or "").strip(),
        "version": str(headers.get("X-Client-Version") or "").strip(),
        "protocolVersion": str(headers.get("X-Protocol-Version") or "").strip(),
        "securityProtocolVersion": str(headers.get("X-Security-Protocol-Version") or "").strip(),
        "desktopProtocolVersion": str(headers.get("X-Desktop-Protocol-Version") or "").strip(),
        "updaterProtocolVersion": str(headers.get("X-Updater-Protocol-Version") or "").strip(),
        "deviceId": str(headers.get("X-Device-Id") or "").strip(),
        "releaseSequence": str(headers.get("X-Release-Sequence") or "0").strip(),
    }
    # Reject legacy shared upload token outright when retired
    pol = vp.load(data_dir)
    tok = str(headers.get("X-Upload-Token") or "").strip()
    auth = str(headers.get("Authorization") or "")
    if pol.get("legacyUploadTokenRetired", True) and (tok or auth.lower().startswith("bearer ")):
        # Still allow if ALSO has valid device signature (ignore token)
        pass

    verdict = vp.evaluate_client(meta, pol=pol, data_dir=data_dir)
    if not verdict.get("ok"):
        send(int(verdict.get("httpStatus") or 426), {
            "ok": False,
            "code": verdict.get("code") or "CLIENT_UPGRADE_REQUIRED",
            "message": verdict.get("message") or "当前版本已停止使用。",
            "minimumVersion": verdict.get("minimumVersion"),
            "minimumBuildId": verdict.get("minimumBuildId"),
            "minimumReleaseSequence": verdict.get("minimumReleaseSequence"),
        })
        return None

    device_id = meta["deviceId"]
    ts_s = str(headers.get("X-Device-Timestamp") or "").strip()
    nonce = str(headers.get("X-Device-Nonce") or "").strip()
    sig = str(headers.get("X-Device-Signature") or "").strip()
    if not device_id or not ts_s or not nonce or not sig:
        send(403, {"ok": False, "code": "DEVICE_AUTH_REQUIRED", "message": "当前版本已停止使用。"})
        return None
    try:
        ts = int(ts_s)
    except Exception:
        send(403, {"ok": False, "code": "DEVICE_AUTH_REQUIRED", "message": "时间戳无效"})
        return None
    if abs(time.time() - ts) > 60:
        send(403, {"ok": False, "code": "DEVICE_AUTH_REQUIRED", "message": "时间戳过期"})
        return None

    nonce_res = device_auth.consume_nonce(data_dir, device_id, nonce)
    if not nonce_res.get("ok"):
        send(403, {"ok": False, "code": nonce_res.get("code") or "NONCE_REPLAY", "message": "请求重放或无效"})
        return None

    row = dev.get_device(device_id, data_dir=data_dir)
    if not row:
        send(403, {"ok": False, "code": "DEVICE_NOT_ALLOWED", "message": "设备未登记"})
        return None
    status = str(row.get("status") or "")
    if require_active_device and status != dev.STATUS_ACTIVE:
        send(403, {"ok": False, "code": "DEVICE_NOT_ALLOWED", "message": f"设备状态:{status}"})
        return None

    expected_id = dev.device_id_from_pubkey_b64(str(row.get("publicKey") or ""))
    if not hmac.compare_digest(expected_id, device_id):
        send(403, {"ok": False, "code": "DEVICE_NOT_ALLOWED", "message": "设备身份不匹配"})
        return None

    bh = body_sha256(body_raw)
    msg = sign_message(
        method.upper(),
        path,
        bh,
        ts,
        nonce,
        meta["buildId"],
        meta["releaseSequence"],
        device_id,
    )
    if not verify_ed25519(str(row.get("publicKey")), msg, sig):
        send(403, {"ok": False, "code": "SIGNATURE_INVALID", "message": "设备签名无效"})
        return None

    dev.touch_device(device_id, data_dir=data_dir)
    meta["deviceStatus"] = status
    meta["publicKey"] = row.get("publicKey")
    meta["boundClientId"] = str(row.get("clientId") or "").strip()
    return meta
