#!/usr/bin/env python3
"""Unit tests for WXQK MeshCentral autoconnect patch helpers."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest import mock

from wxqk_patch import (
    AUTH_DONE,
    AUTH_MARKER,
    MARKER_BEGIN,
    MARKER_END,
    _inject,
    _inject_authcookie,
    normalize_tls_offload,
    read_snippet,
)


class WxqkPatchTest(unittest.TestCase):
    def test_snippet_has_required_connect_calls(self):
        snip = read_snippet()
        self.assertIn(MARKER_BEGIN, snip)
        self.assertIn(MARKER_END, snip)
        self.assertIn("connectDesktop(null, 3)", snip)
        self.assertIn("connectDesktop(null, 1)", snip)
        self.assertIn("connectFiles(null, 1)", snip)
        self.assertIn("hideMask", snip)
        self.assertIn("wxqkauto=(desktop|files)", snip)
        self.assertIn("desktop-input", snip)
        self.assertIn("DeskControl", snip)
        self.assertIn("putstore('DeskControl'", snip)

    def test_inject_inserts_once_and_is_idempotent(self):
        snip = read_snippet()
        base = "<html><body><script>var x=1;</script>\n</body>\n</html>\n"
        once, action1 = _inject(base, snip)
        self.assertEqual(action1, "inserted")
        self.assertEqual(once.count(MARKER_BEGIN), 1)
        twice, action2 = _inject(once, snip)
        self.assertEqual(action2, "unchanged")
        self.assertEqual(twice, once)
        self.assertEqual(twice.count("connectDesktop(null, 3)"), 1)

    def test_inject_replaces_old_snippet(self):
        snip = read_snippet()
        old = (
            "<html><body><script>var x=1;\n"
            f"{MARKER_BEGIN}\nold junk\n{MARKER_END}\n"
            "</script>\n</body></html>\n"
        )
        new, action = _inject(old, snip)
        self.assertEqual(action, "replaced")
        self.assertIn("connectDesktop(null, 3)", new)
        self.assertNotIn("old junk", new)
        self.assertEqual(new.count(MARKER_BEGIN), 1)

    def test_authcookie_patch_idempotent(self):
        base = "meshserver = MeshServerCreateControl(domainUrl);\nmeshserver.Start();\n"
        once, a1 = _inject_authcookie(base)
        self.assertEqual(a1, "patched")
        self.assertIn(AUTH_DONE, once)
        self.assertIn(AUTH_MARKER, once)
        twice, a2 = _inject_authcookie(once)
        self.assertEqual(a2, "unchanged")
        self.assertEqual(once.count(AUTH_DONE), 1)

    def test_authcookie_does_not_double_patch_nospace(self):
        # Minified locales may already pass authCookie without spaces.
        base = "meshserver=MeshServerCreateControl(domainUrl,authCookie);\n"
        once, a1 = _inject_authcookie(base)
        self.assertIn(a1, ("marked", "unchanged"))
        self.assertEqual(once.count("authCookie"), 1)
        self.assertNotIn("authCookie)/* WXQK_AUTHCOOKIE_V1 */,authCookie", once)

    def test_normalize_tls_offload_adds_docker_cidr(self):
        s = {"TlsOffload": "127.0.0.1"}
        self.assertTrue(normalize_tls_offload(s))
        self.assertIn("172.16.0.0/12", str(s["TlsOffload"]))
        self.assertFalse(normalize_tls_offload(s))

    def test_version_gate_refuses_non_124(self):
        import wxqk_patch as wp

        with mock.patch.object(wp, "meshcentral_version", return_value="1.1.21"):
            out = wp.apply_autoconnect_patch()
        self.assertFalse(out["ok"])
        self.assertEqual(out["code"], "VERSION_MISMATCH")


if __name__ == "__main__":
    unittest.main()
