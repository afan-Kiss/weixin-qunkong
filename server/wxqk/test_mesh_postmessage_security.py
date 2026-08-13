#!/usr/bin/env python3
"""Unit checks for Mesh embed postMessage origin helpers (admin_ui string contracts)."""

from __future__ import annotations

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ADMIN = (Path(__file__).resolve().parent / "admin_ui.py").read_text(encoding="utf-8")
SNIP = (ROOT / "deploy" / "meshcentral" / "patches" / "wxqk_autoconnect.snippet.js").read_text(
    encoding="utf-8"
)


class MeshPostMessageSecurityTest(unittest.TestCase):
    def test_parent_never_posts_wildcard(self):
        # Direct targetOrigin '*' for desktop-input must not appear
        self.assertIsNone(re.search(r"postMessage\(\s*\{[^}]*desktop-input[^}]*\}\s*,\s*['\"]\\*['\"]", ADMIN))
        self.assertNotIn(",\n      '*'\n    )", ADMIN)
        self.assertIn("meshOrigin", ADMIN)
        self.assertIn("Fail closed", ADMIN)

    def test_parent_validates_iframe_source_and_origin(self):
        self.assertIn("ev.source !== frame.contentWindow", ADMIN)
        self.assertIn("ev.origin || '') !== meshOrigin", ADMIN)
        self.assertIn("parseMeshEmbedOrigin", ADMIN)
        self.assertIn("clearDesktopEmbedSession", ADMIN)

    def test_iframe_validates_parent_source_and_origin(self):
        self.assertIn("isTrustedParentMessage", SNIP)
        self.assertIn("ev.source !== window.parent", SNIP)
        self.assertIn("EXPECTED_WXQK_ORIGIN", SNIP)
        self.assertIn("__WXQK_PARENT_ORIGINS__", SNIP)
        # Must not post to parent with wildcard
        self.assertNotIn("targetOrigin '*'", SNIP)
        self.assertIn("never postMessage to '*'", SNIP)

    def test_default_view_only_still_present(self):
        self.assertIn("允许操作鼠标键盘", ADMIN)
        self.assertIn("DeskControl", SNIP)
        self.assertIn("putstore('DeskControl', 0)", SNIP)
        self.assertIn("deskInputShield", ADMIN)


if __name__ == "__main__":
    unittest.main()
