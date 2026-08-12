"""Unit tests for meshcentral_client (no live MeshCentral required)."""

from __future__ import annotations

import base64
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

# Ensure server/wxqk is importable
import sys

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import meshcentral_client as mc


class MeshCentralClientTest(unittest.TestCase):
    def setUp(self):
        self._env = os.environ.copy()
        # 64 hex chars = 32 bytes
        os.environ["WXQK_MESH_LOGIN_KEY"] = "00" * 32 + "11" * 16
        os.environ["WXQK_MESH_URL"] = "https://mesh.example.invalid"
        os.environ["WXQK_MESH_INTERNAL_URL"] = "http://127.0.0.1:8080"
        os.environ["WXQK_MESH_USER"] = "user//admin"
        os.environ["WXQK_MESH_ENABLED"] = "true"
        os.environ["WXQK_MESH_TIMEOUT"] = "5"

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self._env)

    def test_mint_login_token_cookie_style_roundtrip_structure(self):
        token = mc.mint_login_token("admin", style="cookie", now=lambda: 1_700_000_000)
        self.assertTrue(token)
        self.assertNotIn("+", token)
        self.assertNotIn("/", token)
        # Decode with @$ altchars
        pad = "=" * (-len(token) % 4)
        raw = base64.b64decode(token + pad, altchars=b"@$")
        self.assertGreaterEqual(len(raw), 12 + 16 + 1)
        iv, tag, ciphertext = raw[:12], raw[12:28], raw[28:]
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM

        key = bytes.fromhex(os.environ["WXQK_MESH_LOGIN_KEY"])[:32]
        plain = AESGCM(key).decrypt(iv, ciphertext + tag, None)
        obj = json.loads(plain.decode("utf-8"))
        self.assertEqual(obj["u"], "user//admin")
        self.assertEqual(obj["a"], 3)
        self.assertEqual(obj["time"], 1_700_000_000)

    def test_mint_login_token_control_style(self):
        token = mc.mint_login_token("ops", style="control", domainid="", now=lambda: 100)
        pad = "=" * (-len(token) % 4)
        raw = base64.b64decode(token + pad, altchars=b"@$")
        iv, tag, ciphertext = raw[:12], raw[12:28], raw[28:]
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM

        key = bytes.fromhex(os.environ["WXQK_MESH_LOGIN_KEY"])[:32]
        obj = json.loads(AESGCM(key).decrypt(iv, ciphertext + tag, None).decode("utf-8"))
        self.assertEqual(obj["userid"], "user//ops")
        self.assertEqual(obj["domainid"], "")
        self.assertEqual(obj["time"], 100)

    def test_build_embed_url_desktop_and_files(self):
        with mock.patch.object(mc, "mint_login_token", return_value="tok"):
            desk = mc.build_embed_url("nodeABC", mc.VIEWMODE_DESKTOP, login_token="tok")
            files = mc.build_embed_url("nodeABC", mc.VIEWMODE_FILES, login_token="tok")
            # Full MeshCentral _id must be reduced to leaf for ?node=
            full = mc.build_embed_url("node//UkSNlz7tLeafId", mc.VIEWMODE_DESKTOP, login_token="tok")
        self.assertIn("https://mesh.example.invalid/?", desk)
        self.assertIn("viewmode=11", desk)
        self.assertIn("viewmode=13", files)
        self.assertIn("hide=63", desk)
        self.assertIn("login=tok", desk)
        self.assertIn("node=nodeABC", desk)
        self.assertIn("node=UkSNlz7tLeafId", full)
        self.assertNotIn("node=node//", full)
        with self.assertRaises(ValueError):
            mc.build_embed_url("nodeABC", mc.VIEWMODE_TERMINAL, login_token="tok")

    def test_normalize_node_query_id_strips_prefix(self):
        self.assertEqual(mc.normalize_node_query_id("node//abc"), "abc")
        self.assertEqual(mc.normalize_node_query_id("node/dom/abc"), "abc")
        self.assertEqual(mc.normalize_node_query_id("abc"), "abc")
        self.assertEqual(mc.PINNED_MESHCENTRAL_VERSION, "1.2.4")

    def test_mint_login_token_includes_expire_minutes(self):
        token = mc.mint_login_token("admin", style="cookie", expire_min=45, now=lambda: 1_700_000_000)
        pad = "=" * (-len(token) % 4)
        raw = base64.b64decode(token + pad, altchars=b"@$")
        iv, tag, ciphertext = raw[:12], raw[12:28], raw[28:]
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM

        key = bytes.fromhex(os.environ["WXQK_MESH_LOGIN_KEY"])[:32]
        obj = json.loads(AESGCM(key).decrypt(iv, ciphertext + tag, None).decode("utf-8"))
        self.assertEqual(obj["expire"], 45)
        self.assertEqual(obj["a"], 3)

    def test_disabled_health_and_sessions(self):
        os.environ["WXQK_MESH_ENABLED"] = "false"
        health = mc.health_check()
        self.assertEqual(health["code"], "MESH_DISABLED")
        with tempfile.TemporaryDirectory() as folder:
            data_dir = Path(folder)
            st = mc.get_device_status(data_dir, "c1")
            self.assertEqual(st["code"], "MESH_DISABLED")
            sess = mc.get_remote_session(data_dir, "c1")
            self.assertEqual(sess["code"], "MESH_DISABLED")

    def test_mapping_roundtrip(self):
        with tempfile.TemporaryDirectory() as folder:
            data_dir = Path(folder)
            row = mc.sync_device_mapping(
                data_dir,
                client_id="client-1",
                mesh_node_id="node-9",
                mesh_group_id="group-1",
                mesh_agent_status="online",
                mesh_last_seen="2026-01-01T00:00:00Z",
            )
            self.assertEqual(row["client_id"], "client-1")
            self.assertEqual(row["mesh_node_id"], "node-9")
            got = mc.get_mapping(data_dir, "client-1")
            self.assertIsNotNone(got)
            assert got is not None
            self.assertEqual(got["mesh_group_id"], "group-1")
            status = mc.get_device_status(data_dir, "client-1")
            self.assertTrue(status["ok"])
            self.assertTrue(status["bound"])

            with mock.patch.object(mc, "mint_login_token", return_value="tok"):
                desktop = mc.get_remote_session(data_dir, "client-1")
                files = mc.get_files_session(data_dir, "client-1")
            self.assertTrue(desktop["ok"])
            self.assertIn("viewmode=11", desktop["embedUrl"])
            self.assertTrue(files["ok"])
            self.assertIn("viewmode=13", files["embedUrl"])

    def test_sync_nodes_soft_fail_without_websocket(self):
        with mock.patch.object(mc, "websocket", None):
            result = mc.sync_nodes_via_control()
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "MESH_WS_UNAVAILABLE")
        self.assertEqual(result["nodes"], [])

    def test_match_node_for_client_prefers_exact_unique(self):
        nodes = [
            {"_id": "n1", "name": "client-a", "host": "pc1"},
            {"_id": "n2", "name": "other", "host": "pc2", "desc": "client-a spare"},
        ]
        hit = mc.match_node_for_client(nodes, "client-a")
        self.assertIsNotNone(hit)
        self.assertEqual(hit["_id"], "n1")
        self.assertIsNone(mc.match_node_for_client(nodes, "missing"))
        # Ambiguous exact matches → no bind
        amb = [
            {"_id": "a", "name": "cid1"},
            {"_id": "b", "name": "cid1"},
        ]
        self.assertIsNone(mc.match_node_for_client(amb, "cid1"))

    def test_config_snapshot_hides_key_material(self):
        snap = mc.config_snapshot()
        self.assertTrue(snap["loginKeyConfigured"])
        self.assertNotIn("LOGIN_KEY", json.dumps(snap))
        self.assertNotIn(os.environ["WXQK_MESH_LOGIN_KEY"], json.dumps(snap))

    def test_login_key_accepts_secret_alias(self):
        key = os.environ.pop("WXQK_MESH_LOGIN_KEY")
        os.environ["WXQK_MESH_SECRET"] = key
        token = mc.mint_login_token("admin", style="cookie", now=lambda: 42)
        self.assertTrue(token)
        os.environ["WXQK_MESH_LOGIN_KEY"] = key
        del os.environ["WXQK_MESH_SECRET"]


class MeshApiHandlersTest(unittest.TestCase):
    def setUp(self):
        self._env = os.environ.copy()
        os.environ["WXQK_MESH_ENABLED"] = "false"

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self._env)

    def test_handlers_return_mesh_disabled(self):
        import mesh_api

        captured = {}

        def send(code, obj):
            captured["code"] = code
            captured["obj"] = obj

        with tempfile.TemporaryDirectory() as folder:
            data_dir = Path(folder)
            mesh_api.handle_health(data_dir, send)
            self.assertEqual(captured["obj"]["code"], "MESH_DISABLED")
            mesh_api.handle_status(data_dir, "c1", send)
            self.assertEqual(captured["obj"]["code"], "MESH_DISABLED")
            mesh_api.handle_session_desktop(data_dir, {"clientId": "c1"}, send)
            self.assertEqual(captured["obj"]["code"], "MESH_DISABLED")
            mesh_api.handle_bind(data_dir, {"clientId": "c1", "meshNodeId": "n1"}, send)
            self.assertEqual(captured["obj"]["code"], "MESH_DISABLED")


if __name__ == "__main__":
    unittest.main()
