#!/usr/bin/env python3
"""Targeted publish must honor portable package releaseSequence, not only stable+1."""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

import update_manifest as um


class TargetedReleaseSequenceTest(unittest.TestCase):
    def test_targeted_uses_explicit_and_package_meta_sequence(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            data_dir = Path(tmp)
            root = um._root(data_dir)
            # Global stable lags far behind modern portable package.json sequences.
            (root / "release-manifest.json").write_text(
                json.dumps({"version": "1.87", "releaseSequence": 77, "sha256": "old"}, ensure_ascii=False),
                encoding="utf-8",
            )

            bid = "20260814-test-seq102"
            pkg = root / "packages" / f"{bid}.exe"
            pkg.write_bytes(b"good-v1.106-bytes")
            um.save_package_meta(data_dir, bid, "微信群控系统v1.106.exe", releaseSequence=102)

            out = um.publish_targeted_release(
                data_dir,
                version="1.106",
                build_id=bid,
                target_client_ids=["abcdef12" * 8],
                mandatory=True,
                file_name="微信群控系统v1.106.exe",
                seed_b64="AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
            )
            self.assertTrue(out.get("ok"), out)
            self.assertEqual(int(out["manifest"]["releaseSequence"]), 102)
            self.assertEqual(out["manifest"]["version"], "1.106")
            self.assertTrue(out.get("signature"))
            self.assertTrue(out.get("signatureV2"))

            out2 = um.publish_targeted_release(
                data_dir,
                version="1.106",
                build_id=bid,
                target_client_ids=["abcdef12" * 8],
                mandatory=True,
                file_name="微信群控系统v1.106.exe",
                seed_b64="AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
                release_sequence=110,
            )
            self.assertTrue(out2.get("ok"), out2)
            self.assertEqual(int(out2["manifest"]["releaseSequence"]), 110)


if __name__ == "__main__":
    unittest.main()
