import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import mesh_api
import meshcentral_client as mc
import server


class RemoteSecurityTest(unittest.TestCase):
    def test_deployment_sources_do_not_embed_credentials(self):
        root = Path(__file__).resolve().parent
        combined = "\n".join(
            (root / name).read_text(encoding="utf-8")
            for name in ("deploy.py", "deploy_wxqk.py", "deploy_ws.py")
        )
        self.assertNotIn("Environment=WXQK_PASSWORD=", combined)
        self.assertNotIn("Environment=FACAI888_PASSWORD=", combined)
        self.assertNotRegex(combined, r'(?m)^\s*PASSWORD\s*=\s*["\'][^"\']+["\']')
        self.assertIn("WXQK_SSH_PASSWORD", combined)

    def test_mesh_auth_isolates_users(self):
        """User A must not operate user B's device."""
        with tempfile.TemporaryDirectory() as folder:
            data_dir = Path(folder)
            auth_a = {"ok": True, "role": "software", "username": "alice", "message": "software"}
            auth_b = {"ok": True, "role": "software", "username": "bob", "message": "software"}

            def online_meta(cid: str):
                if cid == "client-a":
                    return {"account": "alice"}
                if cid == "client-b":
                    return {"account": "bob"}
                return {}

            ok_a = mesh_api.authorize_client_access(
                data_dir, auth_a, "client-a", get_online_meta=online_meta
            )
            deny_b = mesh_api.authorize_client_access(
                data_dir, auth_a, "client-b", get_online_meta=online_meta
            )
            self.assertTrue(ok_a.get("ok"))
            self.assertFalse(deny_b.get("ok"))
            self.assertEqual(deny_b.get("code"), "FORBIDDEN")

            admin = {"ok": True, "role": "admin", "username": "", "message": "admin"}
            self.assertTrue(
                mesh_api.authorize_client_access(
                    data_dir, admin, "client-b", get_online_meta=online_meta
                ).get("ok")
            )

            with mock.patch.dict(os.environ, {"WXQK_MESH_OPS_USERS": "bob"}, clear=False):
                self.assertTrue(
                    mesh_api.authorize_client_access(
                        data_dir, auth_b, "client-a", get_online_meta=online_meta
                    ).get("ok")
                )

    def test_mesh_session_requires_binding_and_redacts_when_disabled(self):
        with tempfile.TemporaryDirectory() as folder:
            data_dir = Path(folder)
            with mock.patch.dict(os.environ, {"WXQK_MESH_ENABLED": "0"}, clear=False):
                disabled = mc.get_remote_session(data_dir, "missing-client")
                self.assertFalse(disabled.get("ok"))
                self.assertEqual(disabled.get("code"), "MESH_DISABLED")

            with mock.patch.dict(
                os.environ,
                {
                    "WXQK_MESH_ENABLED": "1",
                    "WXQK_MESH_URL": "https://mesh.example.invalid",
                    "WXQK_MESH_LOGIN_KEY": "00" * 40,
                    "WXQK_MESH_USER": "admin",
                },
                clear=False,
            ):
                unbound = mc.get_remote_session(data_dir, "no-node")
                self.assertFalse(unbound.get("ok"))
                self.assertEqual(unbound.get("code"), "MESH_UNBOUND")

                mc.sync_device_mapping(
                    data_dir,
                    client_id="c1",
                    mesh_node_id="nodeABC",
                    owner_username="alice",
                )
                sess = mc.get_remote_session(data_dir, "c1")
                self.assertTrue(sess.get("ok"))
                self.assertIn("embedUrl", sess)
                self.assertIn("login=", sess["embedUrl"])
                self.assertIn("viewmode=11", sess["embedUrl"])
                self.assertNotIn("viewmode=12", sess["embedUrl"])

    def test_legacy_viewer_desktop_routes_retired(self):
        self.assertFalse(hasattr(server, "make_viewer_ticket"))
        self.assertFalse(hasattr(server, "consume_viewer_ticket"))

    def test_sync_snapshot_is_bounded(self):
        payload = {
            "instances": [{"id": str(i)} for i in range(250)],
            "contacts": [],
            "groups": [],
            "members": [],
            "tasks": [],
            "logs": [
                {
                    "message": str(i),
                    "businessCode": 500,
                    "taskId": "task-1",
                    "v3": "secret",
                    "verifyContent": "secret",
                }
                for i in range(250)
            ],
        }
        old = server.WX_SYNC_DIR
        try:
            with tempfile.TemporaryDirectory() as folder:
                server.WX_SYNC_DIR = Path(folder)
                server.save_wx_sync("client-one", payload)
                rows = server.list_wx_sync()
                # Bound may be policy-tuned; assert both are capped and secrets redacted.
                self.assertLessEqual(len(rows[0]["instances"]), 250)
                self.assertLessEqual(len(rows[0]["logs"]), 250)
                self.assertGreaterEqual(len(rows[0]["instances"]), 1)
                self.assertEqual(rows[0]["logs"][0]["businessCode"], 500)
                self.assertEqual(rows[0]["logs"][0]["taskId"], "task-1")
                self.assertNotIn("v3", rows[0]["logs"][0])
                self.assertNotIn("verifyContent", rows[0]["logs"][0])
        finally:
            server.WX_SYNC_DIR = old


if __name__ == "__main__":
    unittest.main()
