import unittest
from pathlib import Path

import server


class RemoteSecurityTest(unittest.TestCase):
    def test_deployment_sources_do_not_embed_credentials(self):
        root = Path(__file__).resolve().parent
        combined = "\n".join((root / name).read_text(encoding="utf-8") for name in ("deploy.py", "deploy_wxqk.py", "deploy_ws.py"))
        self.assertNotIn("Environment=WXQK_PASSWORD=", combined)
        self.assertNotIn("Environment=FACAI888_PASSWORD=", combined)
        self.assertNotRegex(combined, r'PASSWORD\s*=\s*["\'][^"\']+["\']')
        self.assertIn("WXQK_SSH_PASSWORD", combined)

    def test_viewer_ticket_is_single_use_and_bound_to_client(self):
        ticket = server.make_viewer_ticket("client-one")
        self.assertFalse(server.consume_viewer_ticket(ticket, "client-two"))
        ticket = server.make_viewer_ticket("client-one")
        self.assertTrue(server.consume_viewer_ticket(ticket, "client-one"))
        self.assertFalse(server.consume_viewer_ticket(ticket, "client-one"))

    def test_sync_snapshot_is_bounded(self):
        payload = {"instances": [{"id": str(i)} for i in range(250)], "contacts": [], "groups": [], "members": [], "tasks": [], "logs": [{"message": str(i)} for i in range(250)]}
        old = server.WX_SYNC_DIR
        try:
            import tempfile
            from pathlib import Path
            with tempfile.TemporaryDirectory() as folder:
                server.WX_SYNC_DIR = Path(folder)
                server.save_wx_sync("client-one", payload)
                rows = server.list_wx_sync()
                self.assertEqual(len(rows[0]["instances"]), 200)
                self.assertEqual(len(rows[0]["logs"]), 200)
        finally:
            server.WX_SYNC_DIR = old


if __name__ == "__main__":
    unittest.main()
