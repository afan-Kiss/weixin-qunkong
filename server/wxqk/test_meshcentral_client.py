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
            online_nodes = {
                "ok": True,
                "code": "OK",
                "nodes": [{"_id": "node-9", "name": "WXQK-client-1", "conn": 1}],
            }
            mc.clear_live_status_cache()
            with mock.patch.object(mc, "sync_nodes_via_control", return_value=online_nodes):
                status = mc.get_device_status(data_dir, "client-1")
                self.assertTrue(status["ok"])
                self.assertTrue(status["bound"])
                self.assertTrue(status["ready"])
                self.assertEqual(status["remoteState"], mc.REMOTE_STATE_READY)

                with mock.patch.object(mc, "mint_login_token", return_value="tok"):
                    desktop = mc.get_remote_session(data_dir, "client-1")
                    files = mc.get_files_session(data_dir, "client-1")
            self.assertTrue(desktop["ok"])
            self.assertIn("viewmode=11", desktop["embedUrl"])
            self.assertTrue(files["ok"])
            self.assertIn("viewmode=13", files["embedUrl"])

    def test_status_mapping_exists_but_node_missing_not_ready(self):
        with tempfile.TemporaryDirectory() as folder:
            data_dir = Path(folder)
            mc.sync_device_mapping(data_dir, client_id="c1", mesh_node_id="old-node")
            mc.clear_live_status_cache()
            with mock.patch.object(
                mc,
                "sync_nodes_via_control",
                return_value={"ok": True, "code": "OK", "nodes": []},
            ):
                st = mc.get_device_status(data_dir, "c1")
            self.assertTrue(st["ok"])
            self.assertFalse(st.get("ready"))
            self.assertNotEqual(st.get("remoteState"), mc.REMOTE_STATE_READY)

    def test_status_node_offline_not_ready(self):
        with tempfile.TemporaryDirectory() as folder:
            data_dir = Path(folder)
            mc.sync_device_mapping(data_dir, client_id="c1", mesh_node_id="n1")
            mc.clear_live_status_cache()
            with mock.patch.object(
                mc,
                "sync_nodes_via_control",
                return_value={
                    "ok": True,
                    "code": "OK",
                    "nodes": [{"_id": "n1", "name": "WXQK-c1", "conn": 0}],
                },
            ):
                st = mc.get_device_status(data_dir, "c1")
            self.assertFalse(st.get("ready"))
            self.assertEqual(st.get("remoteState"), mc.REMOTE_STATE_BOUND_OFFLINE)
            self.assertEqual(st.get("code"), "MESH_AGENT_OFFLINE")

    def test_status_sync_failure_keeps_mapping_not_ready(self):
        with tempfile.TemporaryDirectory() as folder:
            data_dir = Path(folder)
            mc.sync_device_mapping(data_dir, client_id="c1", mesh_node_id="n1")
            mc.clear_live_status_cache()
            with mock.patch.object(
                mc,
                "sync_nodes_via_control",
                return_value={"ok": False, "code": "MESH_WS_ERROR", "message": "boom", "nodes": []},
            ):
                st = mc.get_device_status(data_dir, "c1")
            self.assertFalse(st.get("ready"))
            self.assertTrue(st.get("bound"))
            self.assertFalse(st.get("verified"))
            self.assertEqual(mc.get_mapping(data_dir, "c1")["mesh_node_id"], "n1")

    def test_auto_bind_empty_nodes_does_not_claim_ready(self):
        with tempfile.TemporaryDirectory() as folder:
            data_dir = Path(folder)
            mc.sync_device_mapping(data_dir, client_id="c1", mesh_node_id="stale")
            with mock.patch.object(
                mc,
                "sync_nodes_via_control",
                return_value={"ok": True, "code": "OK", "nodes": []},
            ):
                result = mc.auto_bind_client(data_dir, "c1")
            self.assertFalse(result.get("ok"))
            self.assertFalse(result.get("ready"))
            self.assertEqual(result.get("code"), "MESH_NO_MATCH")
            self.assertEqual(mc.get_mapping(data_dir, "c1")["mesh_node_id"], "stale")

    def test_auto_bind_prefers_online_duplicate_agent_name(self):
        with tempfile.TemporaryDirectory() as folder:
            data_dir = Path(folder)
            mc.sync_device_mapping(data_dir, client_id="c1", mesh_node_id="offline-dup")
            with mock.patch.object(
                mc,
                "sync_nodes_via_control",
                return_value={
                    "ok": True,
                    "code": "OK",
                    "nodes": [
                        {"_id": "offline-dup", "name": "WXQK-c1", "conn": None},
                        {"_id": "online-node", "name": "WXQK-c1", "conn": 1, "meshid": "g"},
                    ],
                },
            ):
                result = mc.auto_bind_client(data_dir, "c1")
            self.assertTrue(result.get("ready"))
            self.assertEqual(result.get("meshNodeId"), "online-node")
            self.assertEqual(mc.get_mapping(data_dir, "c1")["mesh_node_id"], "online-node")

    def test_match_node_prefers_single_online_among_duplicates(self):
        nodes = [
            {"_id": "a", "name": "WXQK-c1", "conn": None},
            {"_id": "b", "name": "WXQK-c1", "conn": 1},
            {"_id": "c", "name": "WXQK-c1"},
        ]
        matched, err = mc.match_node_for_client(nodes, "c1")
        self.assertEqual(err, "")
        self.assertEqual(mc.node_id_of(matched), "b")

    def test_auto_bind_remaps_when_old_node_gone(self):
        with tempfile.TemporaryDirectory() as folder:
            data_dir = Path(folder)
            mc.sync_device_mapping(data_dir, client_id="c1", mesh_node_id="old")
            with mock.patch.object(
                mc,
                "sync_nodes_via_control",
                return_value={
                    "ok": True,
                    "code": "OK",
                    "nodes": [{"_id": "new-node", "name": "WXQK-c1", "conn": 1, "meshid": "g"}],
                },
            ):
                result = mc.auto_bind_client(data_dir, "c1")
            self.assertTrue(result.get("ready"))
            self.assertEqual(result.get("meshNodeId"), "new-node")
            self.assertEqual(mc.get_mapping(data_dir, "c1")["mesh_node_id"], "new-node")

    def test_session_requires_online_node(self):
        with tempfile.TemporaryDirectory() as folder:
            data_dir = Path(folder)
            mc.sync_device_mapping(data_dir, client_id="c1", mesh_node_id="n1")
            mc.clear_live_status_cache()
            with mock.patch.object(
                mc,
                "sync_nodes_via_control",
                return_value={
                    "ok": True,
                    "code": "OK",
                    "nodes": [{"_id": "n1", "name": "WXQK-c1", "conn": 0}],
                },
            ):
                desk = mc.get_remote_session(data_dir, "c1")
                files = mc.get_files_session(data_dir, "c1")
            self.assertFalse(desk.get("ok"))
            self.assertFalse(files.get("ok"))
            self.assertEqual(desk.get("code"), "MESH_AGENT_OFFLINE")
            self.assertNotIn("embedUrl", desk)

    def test_session_online_generates_desktop_and_files(self):
        with tempfile.TemporaryDirectory() as folder:
            data_dir = Path(folder)
            mc.sync_device_mapping(data_dir, client_id="c1", mesh_node_id="n1")
            mc.clear_live_status_cache()
            with mock.patch.object(
                mc,
                "sync_nodes_via_control",
                return_value={
                    "ok": True,
                    "code": "OK",
                    "nodes": [{"_id": "n1", "name": "WXQK-c1", "conn": 1}],
                },
            ):
                with mock.patch.object(mc, "mint_login_token", return_value="tok"):
                    desk = mc.get_remote_session(data_dir, "c1")
                    files = mc.get_files_session(data_dir, "c1")
            self.assertTrue(desk["ok"])
            self.assertTrue(files["ok"])
            self.assertIn("viewmode=11", desk["embedUrl"])
            self.assertIn("hide=63", desk["embedUrl"])
            self.assertIn("viewmode=13", files["embedUrl"])
            self.assertIn("hide=63", files["embedUrl"])
            self.assertIn("node=n1", desk["embedUrl"])
            self.assertIn("node=n1", files["embedUrl"])

    def test_node_is_online_helpers(self):
        self.assertTrue(mc.node_is_online({"conn": 1}))
        self.assertFalse(mc.node_is_online({"conn": 0}))
        self.assertTrue(mc.node_is_online({"online": True}))
        self.assertFalse(mc.node_is_online({}))

    def test_sync_nodes_soft_fail_without_websocket(self):
        with mock.patch.object(mc, "websocket", None):
            result = mc.sync_nodes_via_control()
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "MESH_WS_UNAVAILABLE")
        self.assertEqual(result["nodes"], [])

    def test_match_node_for_client_prefers_exact_unique(self):
        nodes = [
            {"_id": "n1", "name": "WXQK-client-a", "host": "pc1"},
            {"_id": "n2", "name": "other", "host": "pc2", "desc": "client-a spare"},
        ]
        hit, err = mc.match_node_for_client(nodes, "client-a")
        self.assertEqual(err, "")
        self.assertIsNotNone(hit)
        self.assertEqual(hit["_id"], "n1")
        miss, miss_err = mc.match_node_for_client(nodes, "missing")
        self.assertIsNone(miss)
        self.assertEqual(miss_err, "MESH_NO_MATCH")
        # Ambiguous agentName matches → no bind
        amb = [
            {"_id": "a", "name": "WXQK-cid1"},
            {"_id": "b", "name": "WXQK-cid1"},
        ]
        node, code = mc.match_node_for_client(amb, "cid1")
        self.assertIsNone(node)
        self.assertEqual(code, "MESH_AMBIGUOUS")

    def test_match_node_for_client_hostname_fallback(self):
        nodes = [
            {"_id": "n1", "name": "DESKTOP-ABC", "host": "desktop-abc"},
            {"_id": "n2", "name": "other", "host": "pc2"},
        ]
        hit, err = mc.match_node_for_client(nodes, "wxqk-client-uuid", hostname="DESKTOP-ABC")
        self.assertEqual(err, "")
        self.assertIsNotNone(hit)
        self.assertEqual(hit["_id"], "n1")
        # Ambiguous hostname → no bind
        amb = [
            {"_id": "a", "name": "SAME-PC", "host": "same-pc"},
            {"_id": "b", "name": "SAME-PC", "host": "same-pc"},
        ]
        node, code = mc.match_node_for_client(amb, "cid-x", hostname="SAME-PC")
        self.assertIsNone(node)
        self.assertEqual(code, "MESH_HOSTNAME_AMBIGUOUS")
        # Hostname fallback can be disabled for new clients
        none, none_err = mc.match_node_for_client(
            nodes, "wxqk-client-uuid", hostname="DESKTOP-ABC", allow_hostname_fallback=False
        )
        self.assertIsNone(none)
        self.assertEqual(none_err, "MESH_NO_MATCH")

    def test_agent_name_for_client(self):
        self.assertEqual(mc.agent_name_for_client("abc"), "WXQK-abc")
        self.assertEqual(mc.agent_name_for_client(""), "")

    def test_get_remote_session_autobinds_when_unbound(self):
        with tempfile.TemporaryDirectory() as folder:
            data_dir = Path(folder)

            def fake_auto_bind(_data_dir, client_id, **_kwargs):
                mc.sync_device_mapping(
                    data_dir,
                    client_id=client_id,
                    mesh_node_id="node-auto",
                    mesh_group_id="g1",
                    mesh_agent_status="online",
                )
                return {
                    "ok": True,
                    "code": "OK",
                    "bound": True,
                    "online": True,
                    "ready": True,
                    "verified": True,
                    "remoteState": mc.REMOTE_STATE_READY,
                    "meshNodeId": "node-auto",
                    "mapping": {"mesh_node_id": "node-auto"},
                }

            with mock.patch.object(mc, "sync_nodes_via_control", return_value={"ok": True, "nodes": []}):
                with mock.patch.object(mc, "auto_bind_client", side_effect=fake_auto_bind):
                    with mock.patch.object(mc, "mint_login_token", return_value="tok"):
                        sess = mc.get_remote_session(data_dir, "c-new", hostname="PC1")
            self.assertTrue(sess["ok"])
            self.assertIn("node=node-auto", sess["embedUrl"])
            self.assertEqual(mc.get_mapping(data_dir, "c-new")["mesh_node_id"], "node-auto")

    def test_config_snapshot_hides_key_material(self):
        snap = mc.config_snapshot()
        self.assertTrue(snap["loginKeyConfigured"])
        self.assertNotIn("LOGIN_KEY", json.dumps(snap))
        self.assertNotIn(os.environ["WXQK_MESH_LOGIN_KEY"], json.dumps(snap))

    def test_health_check_never_returns_login_key(self):
        key = os.environ["WXQK_MESH_LOGIN_KEY"]
        with mock.patch.object(mc, "_http_get", return_value=(200, b"ok", "https://mesh.test")):
            health = mc.health_check(deep=False)
        blob = json.dumps(health)
        self.assertNotIn(key, blob)
        self.assertNotIn("loginTokenKey", blob.lower())
        self.assertIn("loginKeyConfigured", health)
        self.assertTrue(health["loginKeyConfigured"])
        self.assertEqual(health.get("version"), mc.PINNED_MESHCENTRAL_VERSION)
        self.assertTrue(health.get("webRtcDisabled"))

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
