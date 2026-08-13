"""Tests for deploy/meshcentral/manage.py bootstrap helpers (no Docker required)."""

from __future__ import annotations

import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
MANAGE_PATH = ROOT / "deploy" / "meshcentral" / "manage.py"


def _load_manage():
    spec = importlib.util.spec_from_file_location("wxqk_mesh_manage", MANAGE_PATH)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class MeshManageBootstrapTest(unittest.TestCase):
    def setUp(self):
        self.mod = _load_manage()

    def test_validate_rejects_webrtc_true(self):
        with tempfile.TemporaryDirectory() as folder:
            here = Path(folder)
            (here / "VERSION").write_text("MESHCENTRAL_VERSION=1.2.4\n", encoding="utf-8")
            (here / "docker-compose.yml").write_text(
                "services:\n  meshcentral:\n    image: ghcr.io/ylianst/meshcentral:1.2.4\n"
                "    volumes:\n      - ./backups:/opt/meshcentral/meshcentral-backups\n",
                encoding="utf-8",
            )
            bad = {
                "settings": {"webRTC": True, "allowLoginToken": True, "allowFraming": True},
                "domains": {"": {"allowedFramingOrigins": ["https://admin.example"]}},
            }
            (here / "config.json").write_text(json.dumps(bad), encoding="utf-8")
            with mock.patch.object(self.mod, "HERE", here), mock.patch.object(
                self.mod, "VERSION_FILE", here / "VERSION"
            ), mock.patch.object(self.mod, "COMPOSE", here / "docker-compose.yml"), mock.patch.object(
                self.mod, "CFG_EXAMPLE", here / "config.json"
            ):
                self.assertEqual(self.mod.cmd_validate(mock.Mock()), 1)

    def test_validate_rejects_allow_login_token_false(self):
        with tempfile.TemporaryDirectory() as folder:
            here = Path(folder)
            (here / "VERSION").write_text("MESHCENTRAL_VERSION=1.2.4\n", encoding="utf-8")
            (here / "docker-compose.yml").write_text(
                "services:\n  meshcentral:\n    image: ghcr.io/ylianst/meshcentral:1.2.4\n"
                "    volumes:\n      - ./backups:/b\n",
                encoding="utf-8",
            )
            bad = {
                "settings": {"webRTC": False, "allowLoginToken": False, "allowFraming": True},
                "domains": {"": {"allowedFramingOrigins": ["https://admin.example"]}},
            }
            (here / "config.json").write_text(json.dumps(bad), encoding="utf-8")
            with mock.patch.object(self.mod, "HERE", here), mock.patch.object(
                self.mod, "VERSION_FILE", here / "VERSION"
            ), mock.patch.object(self.mod, "COMPOSE", here / "docker-compose.yml"), mock.patch.object(
                self.mod, "CFG_EXAMPLE", here / "config.json"
            ):
                self.assertEqual(self.mod.cmd_validate(mock.Mock()), 1)

    def test_gen_secret_second_run_keeps_key(self):
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / "wxqk-mesh.env"
            args = mock.Mock(write=str(target), show_secret=False, force=False)
            self.assertEqual(self.mod.cmd_gen_secret(args), 0)
            first = self.mod._load_env_file(target)["WXQK_MESH_LOGIN_KEY"]
            self.assertGreaterEqual(len(first), 64)
            self.assertEqual(self.mod.cmd_gen_secret(args), 0)
            second = self.mod._load_env_file(target)["WXQK_MESH_LOGIN_KEY"]
            self.assertEqual(first, second)

    def test_gen_secret_does_not_print_secret_by_default(self):
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / "wxqk-mesh.env"
            args = mock.Mock(write=str(target), show_secret=False, force=True)
            import io
            from contextlib import redirect_stdout

            buf = io.StringIO()
            with redirect_stdout(buf):
                self.mod.cmd_gen_secret(args)
            out = buf.getvalue()
            key = self.mod._load_env_file(target)["WXQK_MESH_LOGIN_KEY"]
            self.assertIn("Fingerprint:", out)
            self.assertIn("Configured:", out)
            self.assertNotIn(key, out)

    def test_prepare_is_idempotent(self):
        with tempfile.TemporaryDirectory() as folder:
            here = Path(folder)
            example_env = here / ".env.example"
            example_cfg = here / "config.example.json"
            example_env.write_text("MESHCENTRAL_VERSION=1.2.4\nWXQK_MESH_LOGIN_KEY=\n", encoding="utf-8")
            example_cfg.write_text(
                json.dumps(
                    {
                        "settings": {"webRTC": False, "allowLoginToken": True, "allowFraming": True},
                        "domains": {"": {"allowedFramingOrigins": ["https://a"]}},
                    }
                ),
                encoding="utf-8",
            )
            with mock.patch.object(self.mod, "HERE", here), mock.patch.object(
                self.mod, "ENV_EXAMPLE", example_env
            ), mock.patch.object(self.mod, "CFG_EXAMPLE", example_cfg):
                self.assertEqual(self.mod.cmd_prepare(mock.Mock()), 0)
                env1 = (here / ".env").read_text(encoding="utf-8")
                self.assertEqual(self.mod.cmd_prepare(mock.Mock()), 0)
                env2 = (here / ".env").read_text(encoding="utf-8")
                self.assertEqual(env1, env2)

    def test_redact_secret_text(self):
        raw = "WXQK_MESH_LOGIN_KEY=" + ("ab" * 40)
        red = self.mod._redact_secret_text(raw)
        self.assertIn("<redacted>", red)
        self.assertNotIn("ababab", red)

    def test_doctor_masks_login_key_in_stdout(self):
        with tempfile.TemporaryDirectory() as folder:
            here = Path(folder)
            key = "cd" * 40
            (here / "VERSION").write_text("MESHCENTRAL_VERSION=1.2.4\n", encoding="utf-8")
            (here / "config.json").write_text(
                json.dumps(
                    {
                        "settings": {"webRTC": False, "allowLoginToken": True, "allowFraming": True},
                        "domains": {"": {"allowedFramingOrigins": ["https://admin.example"]}},
                    }
                ),
                encoding="utf-8",
            )
            (here / ".env").write_text(
                "MESHCENTRAL_VERSION=1.2.4\nWXQK_MESH_ENABLED=1\n"
                "WXQK_MESH_URL=https://mesh.example\nWXQK_MESH_INTERNAL_URL=http://127.0.0.1:9\n"
                f"WXQK_MESH_LOGIN_KEY={key}\nWXQK_MESH_AGENT_PORT=9\n",
                encoding="utf-8",
            )
            (here / "wxqk-mesh.env").write_text(
                f"WXQK_MESH_ENABLED=1\nWXQK_MESH_URL=https://mesh.example\nWXQK_MESH_LOGIN_KEY={key}\n",
                encoding="utf-8",
            )
            import io
            from contextlib import redirect_stdout

            args = mock.Mock(allow_control_fail=True, allow_health_fail=True, wxqk_health_url="")
            buf = io.StringIO()
            with mock.patch.object(self.mod, "HERE", here), mock.patch.object(
                self.mod, "VERSION_FILE", here / "VERSION"
            ), mock.patch.object(self.mod, "CFG_EXAMPLE", here / "config.json"), mock.patch.object(
                self.mod, "WXQK_MESH_ENV_LOCAL", here / "wxqk-mesh.env"
            ), mock.patch.object(self.mod, "WXQK_MESH_ENV_DEFAULT", here / "missing-system-mesh.env"), mock.patch.object(
                self.mod, "_docker_available", return_value=False
            ), mock.patch.object(self.mod, "_compose_plugin_ok", return_value=(False, "missing")), mock.patch.object(
                self.mod, "_http_ok", return_value=(False, "down")
            ), redirect_stdout(buf):
                rc = self.mod.cmd_doctor(args)
            out = buf.getvalue()
            self.assertNotIn(key, out)
            self.assertIn("fingerprint=", out)
            self.assertIn("[FAIL]", out)
            self.assertNotEqual(rc, 0)

    def test_sync_wxqk_mesh_env_keeps_existing_key_on_rewrite(self):
        with tempfile.TemporaryDirectory() as folder:
            here = Path(folder)
            key = "ef" * 40
            local = here / "wxqk-mesh.env"
            with mock.patch.object(self.mod, "HERE", here), mock.patch.object(
                self.mod, "WXQK_MESH_ENV_LOCAL", local
            ), mock.patch.object(self.mod, "WXQK_MESH_ENV_DEFAULT", here / "no-system"):
                self.mod._sync_wxqk_mesh_env(key, {"WXQK_MESH_URL": "https://mesh.example"})
                first = self.mod._load_env_file(local)["WXQK_MESH_LOGIN_KEY"]
                self.mod._sync_wxqk_mesh_env(key, {"WXQK_MESH_URL": "https://mesh.example"})
                second = self.mod._load_env_file(local)["WXQK_MESH_LOGIN_KEY"]
                self.assertEqual(first, second)
                self.assertEqual(first, key)

    def test_production_identity_guard_fail_closed_marker_without_cert(self):
        with tempfile.TemporaryDirectory() as folder:
            here = Path(folder)
            (here / "data").mkdir(parents=True)
            (here / ".wxqk-production-mesh").write_text("2026-01-01", encoding="utf-8")
            (here / "data" / "wxqk-mesh-production-identity.json").write_text("{}", encoding="utf-8")
            with mock.patch.object(self.mod, "HERE", here), mock.patch.object(
                self.mod, "PRODUCTION_MARKER", here / ".wxqk-production-mesh"
            ), mock.patch.object(
                self.mod, "PRODUCTION_MANIFEST", here / "data" / "wxqk-mesh-production-identity.json"
            ):
                ok, code = self.mod._production_identity_guard()
                self.assertFalse(ok)
                self.assertEqual(code, "MESH_PRODUCTION_IDENTITY_MISSING")

    def test_production_identity_guard_ok_with_agentserver_cert(self):
        with tempfile.TemporaryDirectory() as folder:
            here = Path(folder)
            (here / "data").mkdir(parents=True)
            (here / ".wxqk-production-mesh").write_text("2026-01-01", encoding="utf-8")
            (here / "data" / "agentserver-cert-public.crt").write_text("CERT", encoding="utf-8")
            with mock.patch.object(self.mod, "HERE", here), mock.patch.object(
                self.mod, "PRODUCTION_MARKER", here / ".wxqk-production-mesh"
            ), mock.patch.object(
                self.mod, "PRODUCTION_MANIFEST", here / "data" / "wxqk-mesh-production-identity.json"
            ):
                ok, code = self.mod._production_identity_guard()
                self.assertTrue(ok)
                self.assertEqual(code, "OK")

    def test_tls_pins_required_when_production_marker(self):
        with tempfile.TemporaryDirectory() as folder:
            here = Path(folder)
            marker = here / ".wxqk-production-mesh"
            marker.write_text("x", encoding="utf-8")
            with mock.patch.object(self.mod, "PRODUCTION_MARKER", marker), mock.patch.object(
                self.mod, "PRODUCTION_MANIFEST", here / "missing-manifest"
            ), mock.patch.dict(os.environ, {"WXQK_TLS_SPKI_PINS": ""}, clear=False):
                # Ensure pin file path does not exist on this lab machine path is absolute;
                # empty env pins + marker → TLS_PINS_REQUIRED
                ok, detail = self.mod._check_tls_spki_against_pins()
                if Path("/etc/wxqk/le-ip-expected-spki.txt").exists():
                    self.skipTest("host has pin file")
                self.assertFalse(ok)
                self.assertIn("TLS_PINS_REQUIRED", detail)


if __name__ == "__main__":
    unittest.main()
