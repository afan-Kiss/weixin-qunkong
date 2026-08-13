"""Tests for server-only mesh.env loading."""

from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import mesh_env_loader as mel


class MeshEnvLoaderTest(unittest.TestCase):
    def test_loads_mesh_keys_without_overriding_process_env(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "mesh.env"
            path.write_text(
                "WXQK_MESH_ENABLED=1\nWXQK_MESH_URL=https://mesh.example\n"
                "WXQK_MESH_LOGIN_KEY=" + ("ab" * 40) + "\nOTHER=ignore\n",
                encoding="utf-8",
            )
            with mock.patch.dict(os.environ, {"WXQK_MESH_URL": "https://keep.example"}, clear=False):
                # Ensure clean mesh keys except URL which must be kept
                os.environ.pop("WXQK_MESH_ENABLED", None)
                os.environ.pop("WXQK_MESH_LOGIN_KEY", None)
                with mock.patch.object(mel, "iter_mesh_env_candidates", return_value=[path]):
                    loaded = mel.load_mesh_env_files()
                self.assertEqual(loaded, [str(path)])
                self.assertEqual(os.environ.get("WXQK_MESH_URL"), "https://keep.example")
                self.assertEqual(os.environ.get("WXQK_MESH_ENABLED"), "1")
                self.assertEqual(len(os.environ.get("WXQK_MESH_LOGIN_KEY") or ""), 80)
                self.assertIsNone(os.environ.get("OTHER"))

    def test_wxqk_env_only_takes_mesh_keys(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "wxqk.env"
            path.write_text(
                "WXQK_MESH_ENABLED=1\nFACAI888_PORT=9\nWXQK_MESH_USER=user//admin\n",
                encoding="utf-8",
            )
            with mock.patch.dict(os.environ, {}, clear=False):
                for k in ("WXQK_MESH_ENABLED", "WXQK_MESH_USER", "FACAI888_PORT"):
                    os.environ.pop(k, None)
                with mock.patch.object(mel, "iter_mesh_env_candidates", return_value=[path]):
                    mel.load_mesh_env_files()
                self.assertEqual(os.environ.get("WXQK_MESH_ENABLED"), "1")
                self.assertEqual(os.environ.get("WXQK_MESH_USER"), "user//admin")
                self.assertIsNone(os.environ.get("FACAI888_PORT"))


if __name__ == "__main__":
    unittest.main()
