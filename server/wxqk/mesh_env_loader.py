"""Load server-only MeshCentral env files into os.environ (never used by Electron).

Search order (process env already set wins unless override_existing=True):
  1) WXQK_MESH_ENV_FILE (explicit)
  2) /etc/wxqk/mesh.env
  3) deploy/meshcentral/wxqk-mesh.env (lab / same-host checkout)
  4) /etc/wxqk/wxqk.env (legacy combined — only WXQK_MESH_* / MESHCENTRAL_VERSION)
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Iterable

_ALLOWED_PREFIXES = ("WXQK_MESH_",)
_ALLOWED_KEYS = frozenset({"MESHCENTRAL_VERSION"})
_DEFAULT_CANDIDATES = (
    Path("/etc/wxqk/mesh.env"),
    Path(__file__).resolve().parents[2] / "deploy" / "meshcentral" / "wxqk-mesh.env",
    Path("/etc/wxqk/wxqk.env"),
)


def _parse_env_lines(text: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for raw in str(text or "").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, val = line.split("=", 1)
        key = key.strip()
        if not key:
            continue
        out[key] = val.strip().strip('"').strip("'")
    return out


def _is_mesh_key(key: str) -> bool:
    if key in _ALLOWED_KEYS:
        return True
    return any(key.startswith(p) for p in _ALLOWED_PREFIXES)


def iter_mesh_env_candidates(extra: Iterable[Path] | None = None) -> list[Path]:
    paths: list[Path] = []
    explicit = str(os.environ.get("WXQK_MESH_ENV_FILE") or "").strip()
    if explicit:
        paths.append(Path(explicit))
    paths.extend(_DEFAULT_CANDIDATES)
    if extra:
        paths.extend(Path(p) for p in extra)
    seen: set[str] = set()
    unique: list[Path] = []
    for path in paths:
        key = str(path)
        if key in seen:
            continue
        seen.add(key)
        unique.append(path)
    return unique


def load_mesh_env_files(*, override_existing: bool = False) -> list[str]:
    """
    Apply Mesh-related keys from server env files.
    Returns list of file paths that contributed at least one key.
    Does not print secrets.
    """
    loaded: list[str] = []
    for path in iter_mesh_env_candidates():
        try:
            if not path.is_file():
                continue
            values = _parse_env_lines(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        applied = False
        for key, val in values.items():
            if not _is_mesh_key(key):
                continue
            if not override_existing and key in os.environ and str(os.environ.get(key) or "").strip():
                continue
            os.environ[key] = val
            applied = True
        if applied:
            loaded.append(str(path))
    return loaded
