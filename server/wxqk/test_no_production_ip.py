"""Guards: tracked docs/examples must not embed the real production Mesh IP."""

from __future__ import annotations

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
# Historical production host — must never reappear in tracked public docs/examples/source defaults.
FORBIDDEN_IP = ".".join(("120", "27", "219", "138"))
DOC_GLOBS = (
    "docs/**/*.md",
    "deploy/meshcentral/*.md",
    "deploy/meshcentral/*.example*",
    "deploy/meshcentral/.env.example",
    "server/wxqk/.env.example",
    "admin-ui/scripts/publish-release.ps1",
)


class ProductionIpGuardTest(unittest.TestCase):
    def test_forbidden_production_ip_absent_from_tracked_docs_and_examples(self):
        hits: list[str] = []
        for pattern in DOC_GLOBS:
            for path in ROOT.glob(pattern):
                if not path.is_file():
                    continue
                text = path.read_text(encoding="utf-8", errors="replace")
                if FORBIDDEN_IP in text:
                    hits.append(str(path.relative_to(ROOT)))
        # Also scan manage.py / config.example.json explicitly
        for rel in (
            "deploy/meshcentral/manage.py",
            "deploy/meshcentral/config.example.json",
            "docs/meshcentral-integration.md",
        ):
            path = ROOT / rel
            if path.exists() and FORBIDDEN_IP in path.read_text(encoding="utf-8", errors="replace"):
                hits.append(rel)
        self.assertEqual(hits, [], msg=f"production IP leaked into: {hits}")

    def test_env_examples_have_empty_login_key(self):
        for rel in ("deploy/meshcentral/.env.example", "server/wxqk/.env.example"):
            path = ROOT / rel
            if not path.exists():
                continue
            text = path.read_text(encoding="utf-8")
            m = re.search(r"(?m)^WXQK_MESH_LOGIN_KEY=(.*)$", text)
            self.assertIsNotNone(m, rel)
            assert m is not None
            self.assertEqual(m.group(1).strip(), "", msg=f"{rel} must keep empty login key example")


if __name__ == "__main__":
    unittest.main()
