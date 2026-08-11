# -*- coding: utf-8 -*-
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import update_manifest as um


class PackageDownloadNameTests(unittest.TestCase):
    def test_content_disposition_keeps_chinese_exe_name(self) -> None:
        header = um.content_disposition_attachment("微信群控系统v1.85.exe")
        self.assertIn("attachment;", header)
        self.assertIn("filename*=UTF-8''", header)
        self.assertIn(".exe", header)
        # URL-encoded Chinese product name must be present
        self.assertIn("%E5%BE%AE%E4%BF%A1", header)

    def test_package_download_filename_from_meta(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            data_dir = Path(temp)
            um.save_package_meta(data_dir, "20260812-000701-37c9b1", "微信群控系统v1.85.exe", fileSize=12)
            name = um.package_download_filename(data_dir, "20260812-000701-37c9b1")
            self.assertEqual(name, "微信群控系统v1.85.exe")

    def test_package_download_filename_fallback_adds_exe(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            data_dir = Path(temp)
            name = um.package_download_filename(data_dir, "build-xyz")
            self.assertEqual(name, "build-xyz.exe")


if __name__ == "__main__":
    unittest.main()
