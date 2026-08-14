# -*- coding: utf-8 -*-
"""Release update manifest store for 微信群控 silent updater (same wire as 开云)."""
from __future__ import annotations

import base64
import hashlib
import json
import os
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

_lock = threading.RLock()

SIGNING_KEY_ID = "facai888-v1"
UPDATER_PROTOCOL_V1 = "updater-v1"
UPDATER_PROTOCOL_V2 = "updater-v2"


def normalize_target_client_ids(raw) -> list[str]:
    """Sort + dedupe target client ids for stable v2 signatures."""
    out: list[str] = []
    seen: set[str] = set()
    for item in raw or []:
        cid = str(item or "").strip()
        if not cid or cid in seen:
            continue
        seen.add(cid)
        out.append(cid)
    out.sort()
    return out


def manifest_uses_v2(man: dict[str, Any]) -> bool:
    raw = str((man or {}).get("updaterProtocolVersion") or "").strip().lower()
    if raw in (UPDATER_PROTOCOL_V2, "upd-v2"):
        return True
    digits = "".join(ch for ch in raw if ch.isdigit())
    try:
        return int(digits) >= 2 if digits else False
    except Exception:
        return False


def _root(data_dir: Path) -> Path:
    p = Path(data_dir) / "releases"
    p.mkdir(parents=True, exist_ok=True)
    (p / "packages").mkdir(parents=True, exist_ok=True)
    return p


def load_manifest(data_dir: Path) -> dict[str, Any]:
    path = _root(data_dir) / "release-manifest.json"
    if not path.exists():
        return {
            "version": "0.0.0",
            "buildId": "",
            "gitCommit": "",
            "protocolVersion": "facai888-v1",
            "securityProtocolVersion": "security-v1",
            "desktopProtocolVersion": "desktop-webrtc-v1",
            "updaterProtocolVersion": "updater-v1",
            "mandatory": True,
            "publishedAt": "",
            "minimumSupportedBuild": "",
            "downloadURL": "",
            "fileName": "",
            "fileSize": 0,
            "sha256": "",
            "signingKeyId": SIGNING_KEY_ID,
            "authenticodePublisher": "",
            "releaseSequence": 0,
            "minimumReleaseSequence": 0,
        }
    return json.loads(path.read_text(encoding="utf-8"))


def load_signature_hex(data_dir: Path) -> str:
    path = _root(data_dir) / "release-manifest.sig"
    if not path.exists():
        return ""
    return path.read_text(encoding="utf-8").strip()


def load_signature_v2_hex(data_dir: Path) -> str:
    path = _root(data_dir) / "release-manifest.sig.v2"
    if not path.exists():
        return ""
    return path.read_text(encoding="utf-8").strip()


def _targeted_path(data_dir: Path) -> Path:
    return _root(data_dir) / "targeted-releases.json"


def load_targeted_releases(data_dir: Path) -> dict[str, Any]:
    path = _targeted_path(data_dir)
    if not path.exists():
        return {"releases": []}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            return data
    except Exception:
        pass
    return {"releases": []}


def save_targeted_releases(data_dir: Path, data: dict[str, Any]) -> None:
    path = _targeted_path(data_dir)
    tmp = path.with_suffix(".json.tmp")
    with _lock:
        tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(path)


def resolve_manifest_for_client(
    data_dir: Path,
    *,
    client_id: str = "",
    client_ip: str = "",
    online_lookup=None,
    clients_by_ip=None,
) -> tuple[dict[str, Any], str, str]:
    """Return (manifest, signature_v1, signature_v2). Targeted override wins for matching clientId/IP."""
    stable = load_manifest(data_dir)
    stable_sig = load_signature_hex(data_dir)
    stable_sig_v2 = load_signature_v2_hex(data_dir)
    targeted = load_targeted_releases(data_dir)
    releases = targeted.get("releases") if isinstance(targeted, dict) else []
    if not isinstance(releases, list) or not releases:
        return stable, stable_sig, stable_sig_v2

    cid = str(client_id or "").strip()
    tip = str(client_ip or "").strip()
    candidate_ids: set[str] = set()
    if cid:
        candidate_ids.add(cid)
    if tip and callable(clients_by_ip):
        try:
            for item in clients_by_ip(tip) or []:
                if item:
                    candidate_ids.add(str(item))
        except Exception:
            pass
    # Fall back to persisted client records by IP
    if tip and not candidate_ids:
        clients_dir = Path(data_dir) / "clients"
        if clients_dir.is_dir():
            for path in clients_dir.glob("*.json"):
                try:
                    row = json.loads(path.read_text(encoding="utf-8"))
                except Exception:
                    continue
                if str(row.get("ip") or "").strip() == tip:
                    candidate_ids.add(str(row.get("clientId") or path.stem))

    for rel in releases:
        if not isinstance(rel, dict):
            continue
        targets = normalize_target_client_ids(rel.get("targetClientIds") or [])
        if not targets:
            continue
        if not candidate_ids.intersection(targets):
            continue
        man = rel.get("manifest") if isinstance(rel.get("manifest"), dict) else None
        if not man:
            continue
        sig = str(rel.get("signature") or "") or stable_sig
        sig_v2 = str(rel.get("signatureV2") or "") or stable_sig_v2
        # Ensure target list is visible to new clients
        man = dict(man)
        man["targetClientIds"] = targets
        return man, sig, sig_v2
    return stable, stable_sig, stable_sig_v2


def _max_targeted_release_sequence(data_dir: Path) -> int:
    store = load_targeted_releases(data_dir)
    releases = store.get("releases") if isinstance(store, dict) else []
    highest = 0
    if not isinstance(releases, list):
        return 0
    for rel in releases:
        if not isinstance(rel, dict):
            continue
        man = rel.get("manifest") if isinstance(rel.get("manifest"), dict) else {}
        try:
            highest = max(highest, int(man.get("releaseSequence") or 0))
        except Exception:
            continue
    return highest


def _iter_known_release_artifacts(data_dir: Path) -> list[dict[str, Any]]:
    """Stable + targeted artifacts as {releaseSequence, sha256, buildId, version, source}."""
    out: list[dict[str, Any]] = []
    stable = load_manifest(data_dir)
    try:
        seq = int(stable.get("releaseSequence") or 0)
    except Exception:
        seq = 0
    sha = str(stable.get("sha256") or "").strip().lower()
    if seq > 0 and sha:
        out.append({
            "releaseSequence": seq,
            "sha256": sha,
            "buildId": str(stable.get("buildId") or ""),
            "version": str(stable.get("version") or ""),
            "source": "stable",
        })
    store = load_targeted_releases(data_dir)
    releases = store.get("releases") if isinstance(store, dict) else []
    if not isinstance(releases, list):
        return out
    for rel in releases:
        if not isinstance(rel, dict):
            continue
        man = rel.get("manifest") if isinstance(rel.get("manifest"), dict) else {}
        try:
            seq = int(man.get("releaseSequence") or 0)
        except Exception:
            seq = 0
        sha = str(man.get("sha256") or "").strip().lower()
        if seq <= 0 or not sha:
            continue
        out.append({
            "releaseSequence": seq,
            "sha256": sha,
            "buildId": str(man.get("buildId") or ""),
            "version": str(man.get("version") or ""),
            "source": "targeted",
            "targetClientIds": normalize_target_client_ids(rel.get("targetClientIds") or man.get("targetClientIds") or []),
            "record": rel,
        })
    return out


def resolve_targeted_release_sequence(
    data_dir: Path,
    *,
    digest: str,
    build_id: str = "",
    release_sequence: int | None = None,
    package_meta_sequence: int = 0,
) -> dict[str, Any]:
    """Resolve releaseSequence for a targeted publish.

    Same artifact (sha256) keeps the same sequence across batch targets.
    Different SHA must never reuse an existing sequence.
    """
    sha = str(digest or "").strip().lower()
    if not sha:
        return {"ok": False, "code": "MISSING_SHA256", "message": "sha256 必填"}
    known = _iter_known_release_artifacts(data_dir)
    same = [row for row in known if row.get("sha256") == sha]
    try:
        explicit = int(release_sequence) if release_sequence is not None else 0
    except Exception:
        explicit = 0
    try:
        meta_seq = int(package_meta_sequence or 0)
    except Exception:
        meta_seq = 0

    if same:
        bound = int(same[0]["releaseSequence"])
        desired = bound
        if explicit > 0 and explicit != bound:
            desired = explicit
        elif meta_seq > bound:
            desired = meta_seq
        if desired != bound:
            if desired < bound:
                return {
                    "ok": False,
                    "code": "RELEASE_SEQUENCE_ARTIFACT_CONFLICT",
                    "message": f"同 artifact 已绑定 releaseSequence={bound}，不能降为 {desired}",
                    "releaseSequence": bound,
                }
            for row in known:
                row_seq = int(row.get("releaseSequence") or 0)
                row_sha = str(row.get("sha256") or "").strip().lower()
                if row_seq == desired and row_sha and row_sha != sha:
                    return {
                        "ok": False,
                        "code": "RELEASE_SEQUENCE_ARTIFACT_CONFLICT",
                        "message": f"不能把 artifact 升到 releaseSequence={desired}：已被其他 SHA 占用",
                        "releaseSequence": desired,
                    }
        return {
            "ok": True,
            "releaseSequence": desired,
            "reuseArtifact": True,
            "versionHint": str(same[0].get("version") or ""),
            "existingTargets": normalize_target_client_ids(
                [cid for row in same for cid in (row.get("targetClientIds") or [])]
            ),
        }

    # New artifact: never collide with an existing seq belonging to another SHA.
    max_seq = 0
    for row in known:
        max_seq = max(max_seq, int(row.get("releaseSequence") or 0))
    try:
        stable_seq = int(load_manifest(data_dir).get("releaseSequence") or 0)
    except Exception:
        stable_seq = 0
    max_seq = max(max_seq, stable_seq)
    next_seq = max(1, max_seq + 1)

    def _taken_by_other(seq: int) -> dict[str, Any] | None:
        for row in known:
            row_seq = int(row.get("releaseSequence") or 0)
            row_sha = str(row.get("sha256") or "").strip().lower()
            if row_seq == seq and row_sha and row_sha != sha:
                return row
        return None

    if explicit > 0:
        other = _taken_by_other(explicit)
        if other:
            return {
                "ok": False,
                "code": "RELEASE_SEQUENCE_ARTIFACT_CONFLICT",
                "message": f"releaseSequence={explicit} 已绑定其他 SHA（{str(other.get('sha256'))[:12]}…）",
                "releaseSequence": explicit,
            }
        if explicit < next_seq:
            return {
                "ok": False,
                "code": "RELEASE_SEQUENCE_TOO_LOW",
                "message": f"显式 releaseSequence={explicit} 低于下一可用序号 {next_seq}",
                "releaseSequence": explicit,
            }
        desired = explicit
    else:
        desired = next_seq
        if meta_seq > desired:
            desired = meta_seq
        other = _taken_by_other(desired)
        if other:
            # Package meta asked for a taken seq — safely normalize upward.
            desired = next_seq
            other2 = _taken_by_other(desired)
            if other2:
                return {
                    "ok": False,
                    "code": "RELEASE_SEQUENCE_ARTIFACT_CONFLICT",
                    "message": f"releaseSequence={desired} 已绑定其他 SHA",
                    "releaseSequence": desired,
                }

    return {
        "ok": True,
        "releaseSequence": desired,
        "reuseArtifact": False,
        "existingTargets": [],
    }


def publish_targeted_release(
    data_dir: Path,
    *,
    version: str,
    build_id: str,
    target_client_ids: list[str],
    git_commit: str = "",
    mandatory: bool = True,
    file_name: str = "",
    download_url: str = "",
    seed_b64: str = "",
    public_base_url: str = "https://mesh.example.invalid/wxqk",
    release_sequence: int | None = None,
) -> dict[str, Any]:
    """Publish a package only for selected clientIds; keep global stable manifest unchanged."""
    targets = normalize_target_client_ids(target_client_ids)
    if not targets:
        return {"ok": False, "code": "TARGET_CLIENT_IDS_REQUIRED", "message": "targetClientIds 必填"}
    bid = _safe_build_id(build_id)
    if not bid:
        return {"ok": False, "message": "buildId 必填"}
    pkg = package_path(data_dir, bid)
    if not pkg or not pkg.exists():
        return {"ok": False, "message": "请先上传对应 buildId 的安装包"}
    digest = sha256_file(pkg)
    size = pkg.stat().st_size
    meta = load_package_meta(data_dir, bid)
    try:
        meta_seq = int(meta.get("releaseSequence") or 0)
    except Exception:
        meta_seq = 0
    resolved = resolve_targeted_release_sequence(
        data_dir,
        digest=digest,
        build_id=bid,
        release_sequence=release_sequence,
        package_meta_sequence=meta_seq,
    )
    if not resolved.get("ok"):
        return {
            "ok": False,
            "code": resolved.get("code") or "RELEASE_SEQUENCE_ERROR",
            "message": resolved.get("message") or "releaseSequence 冲突",
        }
    seq = int(resolved["releaseSequence"])
    caller_ver = str(version or "").strip().lstrip("vV")
    if not (len(caller_ver) <= 16 and caller_ver.replace(".", "", 1).isdigit() and caller_ver.count(".") == 1):
        stem = Path(str(file_name or "")).stem
        if "v" in stem.lower():
            maybe = stem.lower().rsplit("v", 1)[-1].strip()
            if maybe.replace(".", "", 1).isdigit() and maybe.count(".") == 1:
                caller_ver = maybe
    # Prefer previously published version label for the same artifact.
    if resolved.get("reuseArtifact") and resolved.get("versionHint"):
        hint = str(resolved.get("versionHint") or "").strip().lstrip("vV")
        if len(hint) <= 16 and hint.replace(".", "", 1).isdigit() and hint.count(".") == 1:
            caller_ver = hint
    ver = caller_ver if (len(caller_ver) <= 16 and caller_ver.replace(".", "", 1).isdigit() and caller_ver.count(".") == 1) else f"1.{max(0, min(9, seq - 1))}"
    fname = str(file_name or "").strip() or f"微信群控系统v{ver}.exe"
    base = str(public_base_url or "").rstrip("/")
    url = str(download_url or "").strip() or (base + "/api/update/package/" + bid)
    published_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    merged_targets = normalize_target_client_ids(list(targets) + list(resolved.get("existingTargets") or []))
    man = {
        "version": ver,
        "buildId": bid,
        "gitCommit": str(git_commit or "").strip(),
        "protocolVersion": "facai888-v1",
        "securityProtocolVersion": "security-v1",
        "desktopProtocolVersion": "desktop-webrtc-v1",
        "updaterProtocolVersion": UPDATER_PROTOCOL_V2,
        "mandatory": bool(mandatory),
        "publishedAt": published_at,
        "minimumSupportedBuild": "",
        "downloadURL": url,
        "fileName": fname,
        "fileSize": int(size),
        "sha256": digest,
        "signingKeyId": SIGNING_KEY_ID,
        "authenticodePublisher": "",
        "releaseSequence": seq,
        "minimumReleaseSequence": 0,
        "targetClientIds": merged_targets,
        "securityEmergency": False,
    }
    sig_v1, sig_v2 = sign_manifest_dual(data_dir, man, seed_b64=seed_b64)
    store = load_targeted_releases(data_dir)
    releases = [r for r in (store.get("releases") or []) if isinstance(r, dict)]
    kept = []
    sha_l = digest.lower()
    for rel in releases:
        old_targets = set(normalize_target_client_ids(rel.get("targetClientIds") or []))
        old_man = rel.get("manifest") if isinstance(rel.get("manifest"), dict) else {}
        old_sha = str(old_man.get("sha256") or "").strip().lower()
        # Drop same-artifact rows (will rewrite merged) and rows overlapping new targets.
        if old_sha and old_sha == sha_l:
            continue
        if old_targets & set(merged_targets):
            continue
        kept.append(rel)
    kept.append({
        "targetClientIds": merged_targets,
        "manifest": man,
        "signature": sig_v1,
        "signatureV2": sig_v2,
        "publishedAt": published_at,
    })
    save_targeted_releases(data_dir, {"releases": kept})
    try:
        import version_policy as vp
        pol = vp.load(data_dir)
        allowed = [str(x) for x in (pol.get("allowedBuildIds") or [])]
        if bid not in allowed:
            allowed.append(bid)
        if "dev" not in allowed:
            allowed.append("dev")
        pol["allowedBuildIds"] = allowed
        vp.save(data_dir, pol)
    except Exception as e:
        return {"ok": False, "message": f"版本策略更新失败（定向清单已写入）: {e}"}
    report_event(data_dir, {
        "t": published_at,
        "event": "TARGETED_RELEASE_PUBLISHED",
        "buildId": bid,
        "version": ver,
        "releaseSequence": seq,
        "sha256": digest,
        "targetClientIds": merged_targets,
        "reuseArtifact": bool(resolved.get("reuseArtifact")),
    })
    return {
        "ok": True,
        "manifest": man,
        "signature": sig_v1,
        "signatureV2": sig_v2,
        "targeted": True,
        "targetClientIds": merged_targets,
        "reuseArtifact": bool(resolved.get("reuseArtifact")),
        "code": "OK",
    }


def package_path(data_dir: Path, build_id: str) -> Path | None:
    """Resolve exactly packages/{buildId}.exe — never glob (avoids .meta.json / .partial)."""
    root = _root(data_dir) / "packages"
    bid = _safe_build_id(build_id)
    if not bid:
        return None
    dest = root / (bid + ".exe")
    if dest.is_file():
        return dest
    return None


def report_event(data_dir: Path, row: dict[str, Any]) -> None:
    path = _root(data_dir) / "update-events.jsonl"
    safe = {k: v for k, v in (row or {}).items() if str(k).lower() not in ("password", "token", "cookie")}
    line = json.dumps(safe, ensure_ascii=False, separators=(",", ":"))
    with _lock:
        with path.open("a", encoding="utf-8") as f:
            f.write(line + "\n")


def recent_events(data_dir: Path, limit: int = 50) -> list[dict[str, Any]]:
    path = _root(data_dir) / "update-events.jsonl"
    if not path.exists():
        return []
    lim = max(1, min(int(limit or 50), 200))
    with _lock:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    out: list[dict[str, Any]] = []
    for line in reversed(lines[-500:]):
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
        except Exception:
            continue
        if isinstance(row, dict):
            out.append(row)
        if len(out) >= lim:
            break
    return out


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        while True:
            chunk = f.read(1024 * 1024)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def _safe_build_id(raw: str) -> str:
    bid = "".join(ch for ch in str(raw or "").strip() if ch.isalnum() or ch in "-_")
    return bid[:80]


def _priv_path(data_dir: Path) -> Path:
    return _root(data_dir) / "publish_ed25519.priv"


def ensure_publish_key(data_dir: Path, seed_b64: str = "") -> bytes:
    """Return 32-byte Ed25519 private seed; create from seed_b64 or generate."""
    path = _priv_path(data_dir)
    with _lock:
        if path.exists():
            raw = path.read_bytes()
            if len(raw) == 32:
                return raw
            try:
                decoded = base64.b64decode(raw.strip())
                if len(decoded) == 32:
                    return decoded
            except Exception:
                pass
        if seed_b64:
            seed = base64.b64decode(seed_b64)
        else:
            seed = os.urandom(32)
        if len(seed) != 32:
            raise ValueError("publish_key_invalid")
        path.write_bytes(seed)
        try:
            os.chmod(path, 0o600)
        except Exception:
            pass
        return seed


def public_key_b64(data_dir: Path, seed_b64: str = "") -> str:
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

    seed = ensure_publish_key(data_dir, seed_b64=seed_b64)
    key = Ed25519PrivateKey.from_private_bytes(seed)
    return base64.b64encode(key.public_key().public_bytes_raw()).decode("ascii")


def canonical_manifest_bytes_v1(man: dict[str, Any]) -> bytes:
    """Must match Go updater.ManifestCanonicalJSON / client canonicalManifestBytesV1."""
    wire = {
        "version": str(man.get("version") or ""),
        "buildId": str(man.get("buildId") or ""),
        "gitCommit": str(man.get("gitCommit") or ""),
        "protocolVersion": str(man.get("protocolVersion") or "facai888-v1"),
        "securityProtocolVersion": str(man.get("securityProtocolVersion") or "security-v1"),
        "desktopProtocolVersion": str(man.get("desktopProtocolVersion") or "desktop-webrtc-v1"),
        "updaterProtocolVersion": str(man.get("updaterProtocolVersion") or UPDATER_PROTOCOL_V1),
        "mandatory": bool(man.get("mandatory", True)),
        "publishedAt": str(man.get("publishedAt") or ""),
        "minimumSupportedBuild": str(man.get("minimumSupportedBuild") or ""),
        "downloadURL": str(man.get("downloadURL") or ""),
        "fileName": str(man.get("fileName") or ""),
        "fileSize": int(man.get("fileSize") or 0),
        "sha256": str(man.get("sha256") or ""),
        "signingKeyId": str(man.get("signingKeyId") or SIGNING_KEY_ID),
        "authenticodePublisher": str(man.get("authenticodePublisher") or ""),
    }
    return json.dumps(wire, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def canonical_manifest_bytes_v2(man: dict[str, Any]) -> bytes:
    """v2 wire: v1 fields + signed control plane (seq / targets / emergency)."""
    wire = {
        "version": str(man.get("version") or ""),
        "buildId": str(man.get("buildId") or ""),
        "gitCommit": str(man.get("gitCommit") or ""),
        "protocolVersion": str(man.get("protocolVersion") or "facai888-v1"),
        "securityProtocolVersion": str(man.get("securityProtocolVersion") or "security-v1"),
        "desktopProtocolVersion": str(man.get("desktopProtocolVersion") or "desktop-webrtc-v1"),
        "updaterProtocolVersion": str(man.get("updaterProtocolVersion") or UPDATER_PROTOCOL_V2),
        "mandatory": bool(man.get("mandatory", True)),
        "publishedAt": str(man.get("publishedAt") or ""),
        "minimumSupportedBuild": str(man.get("minimumSupportedBuild") or ""),
        "downloadURL": str(man.get("downloadURL") or ""),
        "fileName": str(man.get("fileName") or ""),
        "fileSize": int(man.get("fileSize") or 0),
        "sha256": str(man.get("sha256") or ""),
        "signingKeyId": str(man.get("signingKeyId") or SIGNING_KEY_ID),
        "authenticodePublisher": str(man.get("authenticodePublisher") or ""),
        "releaseSequence": int(man.get("releaseSequence") or 0),
        "minimumReleaseSequence": int(man.get("minimumReleaseSequence") or 0),
        "targetClientIds": normalize_target_client_ids(man.get("targetClientIds")),
        "securityEmergency": bool(man.get("securityEmergency")),
    }
    return json.dumps(wire, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def canonical_manifest_bytes(man: dict[str, Any]) -> bytes:
    """Backward-compatible alias → v1 (old clients / tests)."""
    return canonical_manifest_bytes_v1(man)


def sign_manifest(data_dir: Path, man: dict[str, Any], seed_b64: str = "") -> str:
    """Primary signature for the response `signature` field.

    Compatibility: always produce a v1-wire signature here so existing
    clients (updater-v1 only) keep verifying. New clients prefer `signatureV2`.
    """
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

    seed = ensure_publish_key(data_dir, seed_b64=seed_b64)
    key = Ed25519PrivateKey.from_private_bytes(seed)
    sig = key.sign(canonical_manifest_bytes_v1(man))
    return sig.hex()


def sign_manifest_v2(data_dir: Path, man: dict[str, Any], seed_b64: str = "") -> str:
    """v2 control-plane signature (releaseSequence / targets / emergency)."""
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

    seed = ensure_publish_key(data_dir, seed_b64=seed_b64)
    key = Ed25519PrivateKey.from_private_bytes(seed)
    sig = key.sign(canonical_manifest_bytes_v2(man))
    return sig.hex()


def sign_manifest_dual(data_dir: Path, man: dict[str, Any], seed_b64: str = "") -> tuple[str, str]:
    """Return (signature_v1, signature_v2) for transitional publishes."""
    return (
        sign_manifest(data_dir, man, seed_b64=seed_b64),
        sign_manifest_v2(data_dir, man, seed_b64=seed_b64),
    )


def next_release_sequence(data_dir: Path) -> int:
    cur = load_manifest(data_dir)
    try:
        n = int(cur.get("releaseSequence") or 0)
    except Exception:
        n = 0
    return max(1, n + 1)


def _package_meta_path(data_dir: Path, build_id: str) -> Path:
    return _root(data_dir) / "packages" / (build_id + ".meta.json")


def save_package_meta(data_dir: Path, build_id: str, file_name: str, **extra: Any) -> None:
    bid = _safe_build_id(build_id)
    if not bid:
        return
    name = Path(str(file_name or (bid + ".exe"))).name
    if not name.lower().endswith(".exe"):
        name = bid + ".exe"
    row = {"buildId": bid, "fileName": name}
    for k, v in (extra or {}).items():
        if v is not None and str(k) not in ("password", "token"):
            row[str(k)] = v
    path = _package_meta_path(data_dir, bid)
    with _lock:
        path.write_text(json.dumps(row, ensure_ascii=False, indent=2), encoding="utf-8")


def load_package_meta(data_dir: Path, build_id: str) -> dict[str, Any]:
    bid = _safe_build_id(build_id)
    if not bid:
        return {}
    path = _package_meta_path(data_dir, bid)
    if not path.exists():
        return {}
    try:
        row = json.loads(path.read_text(encoding="utf-8"))
        return row if isinstance(row, dict) else {}
    except Exception:
        return {}


def package_download_filename(data_dir: Path, build_id: str) -> str:
    """Original display name for browser downloads (keeps .exe + Chinese product name)."""
    bid = _safe_build_id(build_id)
    if not bid:
        return "package.exe"
    meta = load_package_meta(data_dir, bid)
    name = Path(str(meta.get("fileName") or "")).name.strip()
    if not name:
        try:
            man = load_manifest(data_dir) or {}
            if str(man.get("buildId") or "") == bid:
                name = Path(str(man.get("fileName") or "")).name.strip()
        except Exception:
            name = ""
    if not name:
        name = bid + ".exe"
    # Strip path tricks; force .exe so browsers don't save as bare buildId.
    name = name.replace("\\", "/").split("/")[-1].strip() or (bid + ".exe")
    if not name.lower().endswith(".exe"):
        name = name + ".exe"
    return name


def content_disposition_attachment(filename: str) -> str:
    """RFC 5987 Content-Disposition so Chinese names download correctly."""
    from urllib.parse import quote

    raw = Path(str(filename or "package.exe")).name.strip() or "package.exe"
    if not raw.lower().endswith(".exe"):
        raw = raw + ".exe"
    # ASCII fallback for old browsers / broken proxies
    ascii_name = "".join(ch if 32 <= ord(ch) < 127 and ch not in '"\\' else "_" for ch in raw)
    if not ascii_name.lower().endswith(".exe"):
        ascii_name = (ascii_name or "package") + ".exe"
    encoded = quote(raw, safe="")
    return f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{encoded}"


def store_package(data_dir: Path, build_id: str, file_name: str, blob: bytes) -> dict[str, Any]:
    bid = _safe_build_id(build_id)
    if not bid:
        return {"ok": False, "message": "buildId 无效"}
    if not blob:
        return {"ok": False, "message": "空文件"}
    if len(blob) > 250 * 1024 * 1024:
        return {"ok": False, "message": "文件过大（上限 250MB）"}
    name = Path(str(file_name or (bid + ".exe"))).name
    if not name.lower().endswith(".exe"):
        name = bid + ".exe"
    # Keep package file name as {buildId}.exe for stable download path.
    pkg_name = bid + ".exe"
    dest = _root(data_dir) / "packages" / pkg_name
    with _lock:
        dest.write_bytes(blob)
    save_package_meta(data_dir, bid, name, fileSize=len(blob))
    return {
        "ok": True,
        "buildId": bid,
        "fileName": name,
        "packageName": pkg_name,
        "fileSize": len(blob),
        "sha256": sha256_bytes(blob),
        "path": str(dest),
    }


def store_package_stream(
    data_dir: Path,
    build_id: str,
    file_name: str,
    reader,
    content_length: int,
    *,
    max_bytes: int = 250 * 1024 * 1024,
    chunk_size: int = 1024 * 1024,
) -> dict[str, Any]:
    """Stream package to disk — avoids holding the whole exe in RAM (small VPS / nginx 502).

    Network I/O is intentionally outside `_lock` so /release/status can answer while
    a large upload is still being written (admin UI polls after browser hits 100%).
    """
    bid = _safe_build_id(build_id)
    if not bid:
        return {"ok": False, "message": "buildId 无效"}
    try:
        n = int(content_length or 0)
    except Exception:
        n = 0
    if n > max_bytes:
        return {"ok": False, "message": "文件过大（上限 250MB）"}
    name = Path(str(file_name or (bid + ".exe"))).name
    if not name.lower().endswith(".exe"):
        name = bid + ".exe"
    pkg_name = bid + ".exe"
    root = _root(data_dir) / "packages"
    root.mkdir(parents=True, exist_ok=True)
    dest = root / pkg_name
    tmp = root / (pkg_name + ".partial")
    h = hashlib.sha256()
    written = 0
    try:
        with tmp.open("wb") as out:
            if n > 0:
                left = n
                while left > 0:
                    chunk = reader.read(min(chunk_size, left))
                    if not chunk:
                        break
                    out.write(chunk)
                    h.update(chunk)
                    written += len(chunk)
                    left -= len(chunk)
                if written != n:
                    try:
                        if tmp.exists():
                            tmp.unlink()
                    except Exception:
                        pass
                    return {"ok": False, "message": f"上传不完整（{written}/{n}）"}
            else:
                # Chunked / missing Content-Length — read until EOF (capped).
                while written < max_bytes:
                    chunk = reader.read(chunk_size)
                    if not chunk:
                        break
                    out.write(chunk)
                    h.update(chunk)
                    written += len(chunk)
                if written >= max_bytes:
                    # Likely still more data — reject rather than truncate.
                    try:
                        if tmp.exists():
                            tmp.unlink()
                    except Exception:
                        pass
                    return {"ok": False, "message": "文件过大（上限 250MB）"}
            if written <= 0:
                try:
                    if tmp.exists():
                        tmp.unlink()
                except Exception:
                    pass
                return {"ok": False, "message": "空文件"}
        digest = h.hexdigest()
        with _lock:
            tmp.replace(dest)
            meta_path = _package_meta_path(data_dir, bid)
            meta_path.write_text(
                json.dumps(
                    {"buildId": bid, "fileName": name, "fileSize": written, "sha256": digest},
                    ensure_ascii=False,
                    indent=2,
                ),
                encoding="utf-8",
            )
    except Exception as e:
        try:
            if tmp.exists():
                tmp.unlink()
        except Exception:
            pass
        return {"ok": False, "message": f"写入失败: {e}"}
    return {
        "ok": True,
        "buildId": bid,
        "fileName": name,
        "packageName": pkg_name,
        "fileSize": written,
        "sha256": digest,
        "path": str(dest),
    }


def _upload_session_path(data_dir: Path, build_id: str) -> Path:
    return _root(data_dir) / "packages" / (build_id + ".upload.json")


def begin_chunked_upload(
    data_dir: Path,
    build_id: str,
    file_name: str,
    file_size: int,
    *,
    max_bytes: int = 250 * 1024 * 1024,
) -> dict[str, Any]:
    """Start a chunked package upload (small POSTs survive flaky uplinks)."""
    bid = _safe_build_id(build_id)
    if not bid:
        return {"ok": False, "message": "buildId 无效"}
    try:
        n = int(file_size or 0)
    except Exception:
        n = 0
    if n <= 0:
        return {"ok": False, "message": "fileSize 无效"}
    if n > max_bytes:
        return {"ok": False, "message": "文件过大（上限 250MB）"}
    name = Path(str(file_name or (bid + ".exe"))).name
    if not name.lower().endswith(".exe"):
        name = bid + ".exe"
    root = _root(data_dir) / "packages"
    root.mkdir(parents=True, exist_ok=True)
    tmp = root / (bid + ".exe.partial")
    sess = _upload_session_path(data_dir, bid)
    with _lock:
        try:
            if tmp.exists():
                tmp.unlink()
        except Exception:
            pass
        tmp.write_bytes(b"")
        sess.write_text(
            json.dumps(
                {"buildId": bid, "fileName": name, "fileSize": n, "received": 0},
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
    return {
        "ok": True,
        "buildId": bid,
        "fileName": name,
        "fileSize": n,
        "received": 0,
        "chunkHint": 8 * 1024,
    }


def append_chunked_upload(
    data_dir: Path,
    build_id: str,
    offset: int,
    blob: bytes,
    *,
    max_chunk: int = 32 * 1024,
) -> dict[str, Any]:
    """Append one chunk at the expected offset into the .partial file."""
    bid = _safe_build_id(build_id)
    if not bid:
        return {"ok": False, "message": "buildId 无效"}
    if not blob:
        return {"ok": False, "message": "空分块"}
    if len(blob) > max_chunk:
        return {"ok": False, "message": f"分块过大（上限 {max_chunk} 字节）"}
    try:
        off = int(offset or 0)
    except Exception:
        off = -1
    if off < 0:
        return {"ok": False, "message": "offset 无效"}
    root = _root(data_dir) / "packages"
    tmp = root / (bid + ".exe.partial")
    sess = _upload_session_path(data_dir, bid)
    with _lock:
        if not sess.exists() or not tmp.exists():
            return {"ok": False, "message": "请先初始化分块上传"}
        try:
            row = json.loads(sess.read_text(encoding="utf-8"))
        except Exception:
            return {"ok": False, "message": "上传会话损坏"}
        if not isinstance(row, dict):
            return {"ok": False, "message": "上传会话损坏"}
        expected = int(row.get("fileSize") or 0)
        received = int(tmp.stat().st_size)
        if off != received:
            return {
                "ok": False,
                "message": f"offset 不匹配（期望 {received}，收到 {off}）",
                "received": received,
                "fileSize": expected,
            }
        if received + len(blob) > expected:
            return {"ok": False, "message": "超出声明的文件大小"}
        with tmp.open("ab") as out:
            out.write(blob)
        received = int(tmp.stat().st_size)
        row["received"] = received
        sess.write_text(json.dumps(row, ensure_ascii=False, indent=2), encoding="utf-8")
    return {
        "ok": True,
        "buildId": bid,
        "received": received,
        "fileSize": expected,
        "done": received >= expected,
    }


def finish_chunked_upload(data_dir: Path, build_id: str) -> dict[str, Any]:
    """Finalize a chunked upload into packages/{buildId}.exe + meta."""
    bid = _safe_build_id(build_id)
    if not bid:
        return {"ok": False, "message": "buildId 无效"}
    root = _root(data_dir) / "packages"
    tmp = root / (bid + ".exe.partial")
    dest = root / (bid + ".exe")
    sess = _upload_session_path(data_dir, bid)
    with _lock:
        if not sess.exists() or not tmp.exists():
            return {"ok": False, "message": "没有进行中的分块上传"}
        try:
            row = json.loads(sess.read_text(encoding="utf-8"))
        except Exception:
            return {"ok": False, "message": "上传会话损坏"}
        if not isinstance(row, dict):
            return {"ok": False, "message": "上传会话损坏"}
        expected = int(row.get("fileSize") or 0)
        name = str(row.get("fileName") or (bid + ".exe"))
        size = int(tmp.stat().st_size)
        if size != expected:
            return {"ok": False, "message": f"上传不完整（{size}/{expected}）"}
        digest = sha256_file(tmp)
        tmp.replace(dest)
        try:
            sess.unlink()
        except Exception:
            pass
        meta_path = _package_meta_path(data_dir, bid)
        meta_path.write_text(
            json.dumps(
                {"buildId": bid, "fileName": name, "fileSize": size, "sha256": digest},
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
    return {
        "ok": True,
        "buildId": bid,
        "fileName": name,
        "packageName": bid + ".exe",
        "fileSize": size,
        "sha256": digest,
        "path": str(dest),
    }


def publish_release(
    data_dir: Path,
    *,
    version: str,
    build_id: str,
    git_commit: str = "",
    mandatory: bool = True,
    file_name: str = "",
    download_url: str = "",
    seed_b64: str = "",
    public_base_url: str = "https://mesh.example.invalid/wxqk",
) -> dict[str, Any]:
    bid = _safe_build_id(build_id)
    if not bid:
        return {"ok": False, "message": "buildId 必填"}
    pkg = package_path(data_dir, bid)
    if not pkg or not pkg.exists():
        return {"ok": False, "message": "请先上传对应 buildId 的安装包"}
    digest = sha256_file(pkg)
    size = pkg.stat().st_size
    # Idempotent on content: same sha256 must never bump releaseSequence
    # (admin invents a new timestamp buildId every click — that must not loop clients).
    cur_man = load_manifest(data_dir)
    cur_sha = str(cur_man.get("sha256") or "")
    # 同内容也可纠正 downloadURL / fileName（远端旧品牌误写时需要）
    force_meta = bool(str(download_url or "").strip() or str(file_name or "").strip())
    if cur_sha and cur_sha == digest and not force_meta:
        return {
            "ok": True,
            "manifest": cur_man,
            "signature": load_signature_hex(data_dir),
            "publicKey": public_key_b64(data_dir, seed_b64=seed_b64),
            "unchanged": True,
            "message": "安装包内容未变，未重复递增序号",
        }
    seq = next_release_sequence(data_dir)
    # Prefer explicit x.y from caller / upload fileName (e.g. 微信群控系统v1.2.exe).
    caller_ver = str(version or "").strip().lstrip("vV")
    if not (len(caller_ver) <= 16 and caller_ver.replace(".", "", 1).isdigit() and caller_ver.count(".") == 1):
        stem = Path(str(file_name or "")).stem
        # 微信群控系统v1.2 → 1.2
        if "v" in stem.lower():
            maybe = stem.lower().rsplit("v", 1)[-1].strip()
            if maybe.replace(".", "", 1).isdigit() and maybe.count(".") == 1:
                caller_ver = maybe
    if len(caller_ver) <= 16 and caller_ver.replace(".", "", 1).isdigit() and caller_ver.count(".") == 1:
        ver = caller_ver
        # releaseSequence stays independent; do not derive it from multi-digit minors.
    else:
        # Fallback label only — prefer explicit fileName version (MAJOR.MINOR, minor 0–9).
        ver = f"1.{max(0, min(9, seq - 1))}"
    fname = f"微信群控系统v{ver}.exe"
    base = str(public_base_url or "").rstrip("/")
    url = str(download_url or "").strip() or (base + "/api/update/package/" + bid)
    published_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    man = {
        "version": ver,
        "buildId": bid,
        "gitCommit": str(git_commit or "").strip(),
        "protocolVersion": "facai888-v1",
        "securityProtocolVersion": "security-v1",
        "desktopProtocolVersion": "desktop-webrtc-v1",
        "updaterProtocolVersion": UPDATER_PROTOCOL_V2,
        "mandatory": bool(mandatory),
        "publishedAt": published_at,
        "minimumSupportedBuild": "",
        "downloadURL": url,
        "fileName": fname,
        "fileSize": int(size),
        "sha256": digest,
        "signingKeyId": SIGNING_KEY_ID,
        "authenticodePublisher": "",
        "releaseSequence": seq,
        # Soft floor: do not force-update solely via signed minSeq (policy handles kill-switch).
        "minimumReleaseSequence": 0,
        "targetClientIds": [],
        "securityEmergency": False,
    }
    sig_v1, sig_v2 = sign_manifest_dual(data_dir, man, seed_b64=seed_b64)
    root = _root(data_dir)

    # Manifest first (clients read this), then policy — crash mid-way must not leave
    # latestReleaseSequence ahead of a still-old signed manifest.
    # signature = v1 (legacy clients); signatureV2 file = v2 control-plane.
    with _lock:
        tmp_m = root / "release-manifest.json.tmp"
        tmp_s = root / "release-manifest.sig.tmp"
        tmp_s2 = root / "release-manifest.sig.v2.tmp"
        tmp_m.write_text(json.dumps(man, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp_s.write_text(sig_v1 + "\n", encoding="utf-8")
        tmp_s2.write_text(sig_v2 + "\n", encoding="utf-8")
        tmp_m.replace(root / "release-manifest.json")
        tmp_s.replace(root / "release-manifest.sig")
        tmp_s2.replace(root / "release-manifest.sig.v2")

    try:
        import version_policy as vp

        pol = vp.load(data_dir)
        allowed = [str(x) for x in (pol.get("allowedBuildIds") or [])]
        if bid not in allowed:
            allowed.append(bid)
        if "dev" not in allowed:
            allowed.append("dev")
        # Keep previous latest buildId allowed so mid-fleet clients still pass gate.
        prev = str(cur_man.get("buildId") or "").strip()
        if prev and prev not in allowed:
            allowed.append(prev)
        pol["allowedBuildIds"] = allowed
        pol["latestBuildId"] = bid
        pol["latestVersion"] = ver
        pol["latestReleaseSequence"] = seq
        pol["minimumReleaseSequence"] = 0
        vp.save(data_dir, pol)
    except Exception as e:
        return {"ok": False, "message": f"版本策略更新失败（清单已写入）: {e}"}

    save_package_meta(
        data_dir, bid, fname,
        version=ver, releaseSequence=seq, fileSize=size, sha256=digest, publishedAt=published_at,
    )
    report_event(data_dir, {
        "t": published_at,
        "event": "RELEASE_PUBLISHED",
        "buildId": bid,
        "version": ver,
        "releaseSequence": seq,
        "sha256": digest,
        "fileSize": size,
    })
    return {
        "ok": True,
        "manifest": man,
        "signature": sig_v1,
        "signatureV2": sig_v2,
        "publicKey": public_key_b64(data_dir, seed_b64=seed_b64),
    }


def prune_old_packages(data_dir: Path, *, keep_build_ids: list[str] | None = None) -> dict[str, Any]:
    """Delete obsolete release EXEs / partials / leftover updater to free disk.

    Always keeps the currently published manifest buildId (if any).
    """
    root = _root(data_dir)
    pkg_dir = root / "packages"
    man = load_manifest(data_dir)
    keep: set[str] = set()
    for x in keep_build_ids or []:
        bid = _safe_build_id(str(x))
        if bid:
            keep.add(bid)
    cur = _safe_build_id(str(man.get("buildId") or ""))
    if cur:
        keep.add(cur)
    removed: list[str] = []
    freed = 0
    if pkg_dir.exists():
        for p in list(pkg_dir.iterdir()):
            name = p.name
            if name.endswith(".partial") or name.endswith(".upload.json"):
                try:
                    sz = p.stat().st_size
                    p.unlink()
                    removed.append(name)
                    freed += sz
                except Exception:
                    pass
                continue
            if name.endswith(".meta.json"):
                bid = name[: -len(".meta.json")]
                if keep and bid not in keep:
                    try:
                        sz = p.stat().st_size
                        p.unlink()
                        removed.append(name)
                        freed += sz
                    except Exception:
                        pass
                continue
            if name.lower().endswith(".exe"):
                bid = p.stem
                if keep and bid not in keep:
                    try:
                        sz = p.stat().st_size
                        p.unlink()
                        removed.append(name)
                        freed += sz
                    except Exception:
                        pass
                    meta = pkg_dir / (bid + ".meta.json")
                    if meta.exists():
                        try:
                            freed += meta.stat().st_size
                            meta.unlink()
                            removed.append(meta.name)
                        except Exception:
                            pass
    # Legacy single-file updater no longer distributed.
    for leftover in ("Facai888Updater.exe", "Facai888Updater.exe.sha256"):
        lp = root / leftover
        if lp.exists():
            try:
                sz = lp.stat().st_size
                lp.unlink()
                removed.append(leftover)
                freed += sz
            except Exception:
                pass
    return {"ok": True, "keptBuildIds": sorted(keep), "removed": removed, "freedBytes": freed}


def status(data_dir: Path, seed_b64: str = "") -> dict[str, Any]:
    man = load_manifest(data_dir)
    pkgs = []
    root = _root(data_dir) / "packages"
    man_bid = str(man.get("buildId") or "")
    man_fname = str(man.get("fileName") or "")
    man_ver = str(man.get("version") or "")
    if root.exists():
        for p in sorted(root.glob("*.exe"), key=lambda x: x.stat().st_mtime, reverse=True)[:20]:
            bid = p.stem
            meta = load_package_meta(data_dir, bid)
            display = str(meta.get("fileName") or "").strip()
            if not display and bid == man_bid and man_fname:
                display = man_fname
            if not display and bid == man_bid and man_ver:
                display = f"微信群控系统v{man_ver}.exe"
            if not display:
                display = p.name
            pkgs.append({
                "name": display,
                "packageName": p.name,
                "fileName": display,
                "buildId": bid,
                "version": str(meta.get("version") or (man_ver if bid == man_bid else "") or ""),
                "fileSize": p.stat().st_size,
                "mtime": int(p.stat().st_mtime),
            })
    return {
        "ok": True,
        "manifest": man,
        "signature": load_signature_hex(data_dir),
        "signatureV2": load_signature_v2_hex(data_dir),
        "packages": pkgs,
        "publicKey": public_key_b64(data_dir, seed_b64=seed_b64),
        "events": recent_events(data_dir, 30),
    }
