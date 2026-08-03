# -*- coding: utf-8 -*-
"""Road sequence hash, continuity helpers, and quality grading (A–D)."""
from __future__ import annotations

import hashlib
import json
import re
from typing import Any

from analytics_versions import ANALYTICS_ALGORITHM_VERSION, BIG_ROAD_ALGORITHM_VERSION, DATA_SCHEMA_VERSION

VALID_BEAD = set("BPT")


def compute_seq_hash(day: str, table_id: Any, boot_no: str, seq: str, pairs: str = "") -> str:
    """Stable SHA256: day|tableId|bootNo|seq|pairs"""
    raw = f"{day}|{table_id}|{boot_no or '_'}|{seq or ''}|{pairs or ''}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def soft_fingerprint(seq: str, pairs: str = "", n: int | None = None) -> str:
    """Process-local soft fingerprint (NOT durable). Prefer seq_hash for persistence."""
    s = str(seq or "")
    p = str(pairs or "")
    length = int(n if n is not None else len(s))
    # FNV-1a 32-bit — stable across processes (unlike Python hash())
    h = 2166136261
    for ch in s:
        h ^= ord(ch)
        h = (h * 16777619) & 0xFFFFFFFF
    for ch in p:
        h ^= ord(ch)
        h = (h * 16777619) & 0xFFFFFFFF
    tail = s[-32:] if s else ""
    return f"{length}|{len(s)}|{h:08x}|{tail}"


def validate_beads(seq: str) -> bool:
    return all(ch in VALID_BEAD for ch in str(seq or ""))


def is_unknown_boot(boot_no: str) -> bool:
    b = str(boot_no or "").strip()
    return (not b) or b == "_"


def grade_quality(
    *,
    boot_no: str,
    continuity_ok: bool,
    geometry_verified: bool,
    classification_verified: bool,
    consensus_client_count: int,
    source_client_count: int,
    conflict: bool = False,
    illegal_chars: bool = False,
    legacy: bool = False,
    soft_recovered: bool = False,
    missing_geometry: bool = False,
    shrink_unconfirmed: bool = False,
) -> tuple[str, list[str]]:
    reasons: list[str] = []
    unknown = is_unknown_boot(boot_no)
    if unknown:
        reasons.append("UNKNOWN_BOOT")
    if conflict:
        reasons.append("CLIENT_SEQUENCE_CONFLICT")
    if illegal_chars:
        reasons.append("ILLEGAL_CHARS")
    if shrink_unconfirmed:
        reasons.append("ROAD_SHRINK_UNCONFIRMED")
    if legacy:
        reasons.append("LEGACY_IMPORT")
    if soft_recovered:
        reasons.append("SOFT_CONTINUITY_RECOVERY")
    if missing_geometry or not geometry_verified:
        reasons.append("GEOMETRY_UNVERIFIED")
    if not classification_verified:
        reasons.append("CLASSIFICATION_UNVERIFIED")
    if not continuity_ok:
        reasons.append("CONTINUITY_BROKEN")

    if conflict or illegal_chars or shrink_unconfirmed:
        return "D", reasons
    if unknown or legacy or soft_recovered or missing_geometry or not continuity_ok or not classification_verified:
        return "C", reasons
    # A/B require: known boot, continuity, no conflict, classification + geometry OK
    if (
        not unknown
        and continuity_ok
        and geometry_verified
        and classification_verified
        and not conflict
    ):
        if int(consensus_client_count or 0) >= 2:
            return "A", reasons
        if int(source_client_count or 0) >= 1:
            return "B", reasons
        return "C", reasons + ["NO_CLIENT_SOURCE"]
    return "C", reasons


def boot_meta_from_body(body: dict[str, Any], *, day: str, table_id: Any, boot_no: str) -> dict[str, Any]:
    """Normalize boot JSON body fields for analytics/overview."""
    seq = str(body.get("s") or body.get("seq") or "")
    pairs = str(body.get("p") or body.get("pairs") or "")
    seq_hash = str(body.get("h") or body.get("seqHash") or "") or compute_seq_hash(day, table_id, boot_no, seq, pairs)
    q = str(body.get("q") or body.get("qualityLevel") or "C")
    reasons = body.get("qr") or body.get("qualityReasons") or []
    if isinstance(reasons, str):
        try:
            reasons = json.loads(reasons)
        except Exception:
            reasons = [reasons]
    return {
        "day": day,
        "tableId": int(table_id) if str(table_id).isdigit() else table_id,
        "bootNo": boot_no,
        "seq": seq,
        "pairs": pairs,
        "seqLen": int(body.get("n") or len(seq)),
        "seqHash": seq_hash,
        "qualityLevel": q,
        "qualityReasons": reasons,
        "continuityOk": bool(body.get("co", body.get("continuityOk", False))),
        "geometryVerified": bool(body.get("gv", body.get("geometryVerified", False))),
        "classificationVerified": bool(body.get("cv", body.get("classificationVerified", False))),
        "sourceClientCount": int(body.get("sc", body.get("sourceClientCount") or 0) or 0),
        "consensusClientCount": int(body.get("cc", body.get("consensusClientCount") or 0) or 0),
        "updatedAt": int(body.get("u") or 0),
        "schemaVersion": int(body.get("sv") or DATA_SCHEMA_VERSION),
        "algorithmVersion": str(body.get("av") or ANALYTICS_ALGORITHM_VERSION),
        "bigRoadAlgorithmVersion": str(body.get("bv") or BIG_ROAD_ALGORITHM_VERSION),
    }
