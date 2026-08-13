"""Tests for deploy/meshcentral/manage.py bootstrap helpers (no Docker required)."""

from __future__ import annotations

import importlib.util
import json
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
            self.assertIn("configured=true", out)
            self.assertIn("fingerprint=", out)
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


if __name__ == "__main__":
    unittest.main()
