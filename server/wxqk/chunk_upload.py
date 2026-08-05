# -*- coding: utf-8 -*-
"""Chunked release package upload helpers (small uplink friendly)."""
from __future__ import annotations

import hashlib
import json
import shutil
import threading
from pathlib import Path
from typing import Any

_lock = threading.RLock()
PART_CHUNK_SIZE = 1024 * 1024
MAX_PART_CHUNK_SIZE = 4 * 1024 * 1024


def _safe_build_id(raw: str) -> str:
    return "".join(ch for ch in str(raw or "") if ch.isalnum() or ch in "-_")[:80]


def _root(data_dir: Path) -> Path:
    p = Path(data_dir) / "releases"
    p.mkdir(parents=True, exist_ok=True)
    (p / "packages").mkdir(parents=True, exist_ok=True)
    return p


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        while True:
            b = f.read(1024 * 1024)
            if not b:
                break
            h.update(b)
    return h.hexdigest()


def _parts_dir(data_dir: Path, bid: str) -> Path:
    return _root(data_dir) / "packages" / (bid + ".parts")


def _valid_uploaded_parts(parts: Path, expected: int, chunk_size: int) -> list[int]:
    """Return only complete part indexes, so a retry never trusts a torn write."""
    total = (expected + chunk_size - 1) // chunk_size
    uploaded: list[int] = []
    for index in range(total):
        part = parts / f"{index:06d}.bin"
        expected_size = min(chunk_size, expected - (index * chunk_size))
        if part.exists() and part.stat().st_size == expected_size:
            uploaded.append(index)
    return uploaded


def begin_chunked_upload(
    data_dir: Path,
    build_id: str,
    file_name: str,
    file_size: int,
    chunk_size: int | None = None,
) -> dict[str, Any]:
    """Start (or resume) a parts upload. Optional chunk_size up to 4MB for faster uplinks."""
    bid = _safe_build_id(build_id)
    if not bid:
        return {"ok": False, "message": "buildId 无效"}
    try:
        n = int(file_size or 0)
    except Exception:
        n = 0
    if n <= 0:
        return {"ok": False, "message": "fileSize 无效"}
    if n > 250 * 1024 * 1024:
        return {"ok": False, "message": "文件过大（上限 250MB）"}
    name = Path(str(file_name or (bid + ".exe"))).name
    if not name.lower().endswith(".exe"):
        name = bid + ".exe"
    try:
        requested = int(chunk_size) if chunk_size is not None else PART_CHUNK_SIZE
    except Exception:
        requested = PART_CHUNK_SIZE
    cs = max(64 * 1024, min(MAX_PART_CHUNK_SIZE, requested or PART_CHUNK_SIZE))
    root = _root(data_dir) / "packages"
    tmp = root / (bid + ".exe.partial")
    dest = root / (bid + ".exe")
    sess = root / (bid + ".upload.json")
    parts = _parts_dir(data_dir, bid)
    with _lock:
        # A browser can lose the init/finish response after the server has already
        # acted on it. Reusing this exact build id must not discard durable data.
        if sess.exists() and parts.exists():
            try:
                row = json.loads(sess.read_text(encoding="utf-8"))
            except Exception:
                row = {}
            row_cs = int(row.get("chunkSize") or PART_CHUNK_SIZE) if isinstance(row, dict) else PART_CHUNK_SIZE
            if (
                isinstance(row, dict)
                and str(row.get("mode") or "") == "parts"
                and int(row.get("fileSize") or 0) == n
                and str(row.get("fileName") or "") == name
                and row_cs == cs
            ):
                uploaded = _valid_uploaded_parts(parts, n, cs)
                row["parts"] = len(uploaded)
                sess.write_text(json.dumps(row, ensure_ascii=False), encoding="utf-8")
                return {
                    "ok": True,
                    "buildId": bid,
                    "fileName": name,
                    "fileSize": n,
                    "chunkHint": cs,
                    "mode": "parts",
                    "resumed": True,
                    "uploadedParts": uploaded,
                }
        if dest.exists():
            meta_path = root / (bid + ".meta.json")
            try:
                meta = json.loads(meta_path.read_text(encoding="utf-8")) if meta_path.exists() else {}
            except Exception:
                meta = {}
            if int(dest.stat().st_size) == n and str(meta.get("fileName") or "") == name:
                return {
                    "ok": True,
                    "buildId": bid,
                    "fileName": name,
                    "fileSize": n,
                    "sha256": str(meta.get("sha256") or _sha256_file(dest)),
                    "mode": "complete",
                    "recovered": True,
                }
            return {"ok": False, "message": "该上传编号已被其他安装包使用，请重新选择文件后再试"}
        try:
            if tmp.exists():
                tmp.unlink()
        except Exception:
            pass
        if parts.exists():
            shutil.rmtree(parts, ignore_errors=True)
        parts.mkdir(parents=True, exist_ok=True)
        tmp.write_bytes(b"")
        sess.write_text(
            json.dumps(
                {
                    "buildId": bid,
                    "fileName": name,
                    "fileSize": n,
                    "received": 0,
                    "mode": "parts",
                    "chunkSize": cs,
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
    return {
        "ok": True,
        "buildId": bid,
        "fileName": name,
        "fileSize": n,
        "received": 0,
        "chunkHint": cs,
        "mode": "parts",
    }


def append_chunked_upload(data_dir: Path, build_id: str, offset: int, blob: bytes) -> dict[str, Any]:
    """Legacy sequential append (kept for older clients)."""
    bid = _safe_build_id(build_id)
    if not bid:
        return {"ok": False, "message": "buildId 无效"}
    if not blob:
        return {"ok": False, "message": "空分块"}
    if len(blob) > 32 * 1024:
        return {"ok": False, "message": "分块过大（上限 32KB）"}
    try:
        off = int(offset)
    except Exception:
        return {"ok": False, "message": "offset 无效"}
    root = _root(data_dir) / "packages"
    tmp = root / (bid + ".exe.partial")
    sess = root / (bid + ".upload.json")
    with _lock:
        if not sess.exists() or not tmp.exists():
            return {"ok": False, "message": "请先初始化分块上传"}
        try:
            row = json.loads(sess.read_text(encoding="utf-8"))
        except Exception:
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
        sess.write_text(json.dumps(row, ensure_ascii=False), encoding="utf-8")
    return {
        "ok": True,
        "buildId": bid,
        "received": received,
        "fileSize": expected,
        "done": received >= expected,
    }


def put_chunked_part(
    data_dir: Path,
    build_id: str,
    index: int,
    blob: bytes,
    *,
    chunk_size: int = PART_CHUNK_SIZE,
) -> dict[str, Any]:
    """Write one unordered part file — safe for parallel uploads."""
    bid = _safe_build_id(build_id)
    if not bid:
        return {"ok": False, "message": "buildId 无效"}
    if not blob:
        return {"ok": False, "message": "空分块"}
    if len(blob) > MAX_PART_CHUNK_SIZE:
        return {"ok": False, "message": "分块过大（上限 4MB）"}
    try:
        idx = int(index)
    except Exception:
        return {"ok": False, "message": "index 无效"}
    if idx < 0:
        return {"ok": False, "message": "index 无效"}
    root = _root(data_dir) / "packages"
    sess = root / (bid + ".upload.json")
    parts = _parts_dir(data_dir, bid)
    with _lock:
        if not sess.exists() or not parts.exists():
            return {"ok": False, "message": "请先初始化分块上传"}
        try:
            row = json.loads(sess.read_text(encoding="utf-8"))
        except Exception:
            return {"ok": False, "message": "上传会话损坏"}
        expected = int(row.get("fileSize") or 0)
        cs = int(row.get("chunkSize") or chunk_size)
        start = idx * cs
        if start >= expected:
            return {"ok": False, "message": "index 超出范围"}
        if start + len(blob) > expected:
            return {"ok": False, "message": "分块超出文件末尾"}
        # last chunk may be short
        if start + cs < expected and len(blob) != cs:
            return {"ok": False, "message": f"分块长度应为 {cs}"}
        part = parts / f"{idx:06d}.bin"
        # Retried requests are normal on unreliable uplinks. A complete existing
        # part is already durable, so do not rewrite it just because its response
        # was lost on the way back to the browser.
        if part.exists() and part.stat().st_size == len(blob):
            have = len(_valid_uploaded_parts(parts, expected, cs))
            return {"ok": True, "buildId": bid, "index": idx, "parts": have, "fileSize": expected, "duplicate": True}
        part.write_bytes(blob)
        have = len(_valid_uploaded_parts(parts, expected, cs))
        row["parts"] = have
        sess.write_text(json.dumps(row, ensure_ascii=False), encoding="utf-8")
    return {"ok": True, "buildId": bid, "index": idx, "parts": have, "fileSize": expected}


def finish_chunked_upload(data_dir: Path, build_id: str) -> dict[str, Any]:
    bid = _safe_build_id(build_id)
    if not bid:
        return {"ok": False, "message": "buildId 无效"}
    root = _root(data_dir) / "packages"
    tmp = root / (bid + ".exe.partial")
    dest = root / (bid + ".exe")
    sess = root / (bid + ".upload.json")
    parts = _parts_dir(data_dir, bid)
    with _lock:
        if not sess.exists():
            return {"ok": False, "message": "没有进行中的分块上传"}
        try:
            row = json.loads(sess.read_text(encoding="utf-8"))
        except Exception:
            return {"ok": False, "message": "上传会话损坏"}
        expected = int(row.get("fileSize") or 0)
        name = str(row.get("fileName") or (bid + ".exe"))
        mode = str(row.get("mode") or "")
        if mode == "parts" or (parts.exists() and any(parts.glob("*.bin"))):
            cs = int(row.get("chunkSize") or PART_CHUNK_SIZE)
            total_parts = (expected + cs - 1) // cs
            uploaded = _valid_uploaded_parts(parts, expected, cs)
            uploaded_set = set(uploaded)
            missing = [i for i in range(total_parts) if i not in uploaded_set]
            if missing:
                return {
                    "ok": False,
                    "message": f"缺少分块（如 {missing[:5]}），已有 {total_parts - len(missing)}/{total_parts}",
                    "missingSample": missing[:20],
                    "totalParts": total_parts,
                }
            # Stream the merge. Loading every part into memory makes a 200MB
            # release unnecessarily fragile on a small server.
            with tmp.open("wb") as out:
                for i in range(total_parts):
                    with (parts / f"{i:06d}.bin").open("rb") as src:
                        shutil.copyfileobj(src, out, length=1024 * 1024)
            shutil.rmtree(parts, ignore_errors=True)
        size = int(tmp.stat().st_size) if tmp.exists() else 0
        if size != expected:
            return {"ok": False, "message": f"上传不完整（{size}/{expected}）"}
        digest = _sha256_file(tmp)
        tmp.replace(dest)
        try:
            sess.unlink()
        except Exception:
            pass
        (root / (bid + ".meta.json")).write_text(
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
