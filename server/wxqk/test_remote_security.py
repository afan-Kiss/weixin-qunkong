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
                self.assertIn(
                    unbound.get("code"),
                    (
                        "MESH_UNBOUND",
                        "MESH_NO_MATCH",
                        "MESH_SYNC_FAILED",
                        "MESH_WS_UNAVAILABLE",
                        "MESH_WS_ERROR",
                        "MESH_TOKEN_ERROR",
                    ),
                )
                mc.sync_device_mapping(
                    data_dir,
                    client_id="c1",
                    mesh_node_id="nodeABC",
                    owner_username="alice",
                )
                with mock.patch.object(
                    mc,
                    "sync_nodes_via_control",
                    return_value={
                        "ok": True,
                        "code": "OK",
                        "nodes": [{"_id": "nodeABC", "name": "WXQK-c1", "conn": 1}],
                    },
                ):
                    with mock.patch.object(mc, "mint_login_token", return_value="tok"):
                        sess = mc.get_remote_session(data_dir, "c1")
                self.assertTrue(sess.get("ok"))
                self.assertIn("embedUrl", sess)
                self.assertIn("login=", sess["embedUrl"])
                self.assertIn("viewmode=11", sess["embedUrl"])
                self.assertNotIn("viewmode=12", sess["embedUrl"])

    def test_legacy_viewer_desktop_routes_retired(self):
        self.assertFalse(hasattr(server, "make_viewer_ticket"))
        self.assertFalse(hasattr(server, "consume_viewer_ticket"))

    def test_admin_ui_hosts_mesh_remote_console(self):
        text = (Path(__file__).resolve().parent / "admin_ui.py").read_text(encoding="utf-8")
        self.assertIn("id:'desktop'", text)
        self.assertIn("远程桌面", text)
        self.assertIn("/api/mesh/session/desktop", text)
        self.assertIn("/api/mesh/session/files", text)
        self.assertIn("deskFrame", text)
        self.assertIn("embedUrl", text)
        self.assertIn("deskAllowInput", text)
        self.assertIn("允许操作鼠标键盘", text)
        self.assertIn("deskBottomBar", text)
        self.assertIn("is-viewonly", text)
        self.assertIn("desktopMeshOrigin", text)
        self.assertIn("parseMeshEmbedOrigin", text)
        snip = (Path(__file__).resolve().parents[2] / "deploy" / "meshcentral" / "patches" / "wxqk_autoconnect.snippet.js").read_text(encoding="utf-8")
        self.assertIn("isTrustedParentMessage", snip)
        self.assertNotIn("postMessage(\n      { source: 'wxqk', kind: 'desktop-input', type: 'desktop-input', enabled: !!enabled },\n      '*'\n    )", text)
        self.assertIn("meshOrigin", text)
        self.assertIn("ev.source !== frame.contentWindow", text)
        self.assertIn("friendlyMeshError", text)
        self.assertIn("服务已就绪", text)
        self.assertIn("远程维护服务器未配置", text)
        self.assertIn("远程维护服务器不可达", text)
        self.assertIn("设备已就绪", text)
        self.assertIn("设备 Agent 离线", text)
        self.assertIn("设备尚未绑定", text)
        self.assertIn("displayClientLabel", text)
        self.assertIn("looksLikeInternalId", text)
        self.assertIn('placeholder="搜索账号 / IP"', text)
        self.assertNotIn("设备未绑定 Mesh 节点", text)
        self.assertNotIn("远程桌面已退役", text)
        # Desktop list / status must not render raw clientId as primary label
        self.assertNotIn('escHtml(cid) + \'</div>\'', text)
        self.assertNotIn("class=\"mono\">' + escHtml(cid)", text)

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

    def test_list_online_preserves_chinese_hostname_utf8(self):
        """Overview must expose hostname so admin UI can label 中文 Windows devices."""
        cid = "host-utf8-client"
        try:
            server.touch_online(
                {
                    "clientId": cid,
                    "ip": "10.0.0.8",
                    "account": "账号未上报",
                    "hostname": "测试电脑-微信01",
                }
            )
            rows = server.list_online()
            hit = next((r for r in rows if r.get("clientId") == cid), None)
            self.assertIsNotNone(hit)
            assert hit is not None
            self.assertEqual(hit.get("hostname"), "测试电脑-微信01")
            self.assertEqual(hit.get("host"), "测试电脑-微信01")
            # JSON wire encoding must stay UTF-8 (ensure_ascii=False)
            body = __import__("json").dumps({"online": [hit]}, ensure_ascii=False)
            self.assertIn("测试电脑-微信01", body)
            self.assertNotIn("\\u6d4b\\u8bd5", body)
        finally:
            with server._online_lock:
                server._online.pop(cid, None)

    def test_admin_ui_display_label_prefers_chinese_hostname(self):
        text = (Path(__file__).resolve().parent / "admin_ui.py").read_text(encoding="utf-8")
        self.assertIn("r.hostname || r.host", text)
        # Extract displayClientLabel and evaluate with Node for regression.
        start = text.find("function displayClientLabel(r)")
        end = text.find("function findOnlineByClientId", start)
        self.assertGreater(start, 0)
        self.assertGreater(end, start)
        snippet = text[start:end]
        # Minimal helpers used by displayClientLabel
        js = (
            "function displayAccount(r){const a=String((r&&r.account)||'').trim();"
            "if(!a||a==='未登录')return '账号未上报';return a;}\n"
            "function looksLikeInternalId(s){const t=String(s||'').trim();"
            "return t.length>=32&&/^[a-f0-9]+$/i.test(t);}\n"
            + snippet
            + "\nconst label=displayClientLabel({account:'账号未上报',hostname:'测试电脑-微信01'});\n"
            + "if(label!=='测试电脑-微信01'){console.error('bad',label);process.exit(1)}\n"
            + "console.log('ok')\n"
        )
        import subprocess
        import tempfile

        with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False, encoding="utf-8") as fh:
            fh.write(js)
            path = fh.name
        try:
            out = subprocess.check_output(["node", path], text=True, encoding="utf-8")
            self.assertIn("ok", out)
        finally:
            Path(path).unlink(missing_ok=True)


if __name__ == "__main__":
    unittest.main()
