#!/usr/bin/env python3
"""Targeted releaseSequence: same artifact keeps seq; different SHA never collides."""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

import update_manifest as um

SEED = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
BASE = "https://updates.wxqk.test/wxqk"


def _write_pkg(root: Path, bid: str, blob: bytes, seq: int = 0) -> None:
    pkg = root / "packages" / f"{bid}.exe"
    pkg.write_bytes(blob)
    meta = {"buildId": bid, "fileName": f"{bid}.exe"}
    if seq > 0:
        meta["releaseSequence"] = seq
    (root / "packages" / f"{bid}.meta.json").write_text(json.dumps(meta), encoding="utf-8")


class TargetedReleaseSequenceTest(unittest.TestCase):
    def test_same_artifact_same_and_different_targets_keep_seq(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            data_dir = Path(tmp)
            root = um._root(data_dir)
            (root / "release-manifest.json").write_text(
                json.dumps({"version": "1.87", "releaseSequence": 77, "sha256": "old"}, ensure_ascii=False),
                encoding="utf-8",
            )
            bid = "build-good-102"
            _write_pkg(root, bid, b"good-bytes-v1106", seq=102)
            a = "clientA" + ("0" * 56)
            b = "clientB" + ("0" * 56)

            out1 = um.publish_targeted_release(
                data_dir, version="1.106", build_id=bid, target_client_ids=[a],
                mandatory=True, file_name="寰俊缇ゆ帶绯荤粺v1.106.exe", seed_b64=SEED, public_base_url=BASE,
            )
            self.assertTrue(out1.get("ok"), out1)
            self.assertEqual(int(out1["manifest"]["releaseSequence"]), 102)
            self.assertTrue(out1.get("signature"))
            self.assertTrue(out1.get("signatureV2"))

            out2 = um.publish_targeted_release(
                data_dir, version="1.106", build_id=bid, target_client_ids=[b],
                mandatory=True, file_name="寰俊缇ゆ帶绯荤粺v1.106.exe", seed_b64=SEED, public_base_url=BASE,
            )
            self.assertTrue(out2.get("ok"), out2)
            self.assertEqual(int(out2["manifest"]["releaseSequence"]), 102)
            self.assertTrue(out2.get("reuseArtifact"))
            targets = set(out2.get("targetClientIds") or [])
            self.assertEqual(targets, {a, b})

            # same artifact + same target republish keeps seq
            out3 = um.publish_targeted_release(
                data_dir, version="1.106", build_id=bid, target_client_ids=[a],
                mandatory=True, file_name="寰俊缇ゆ帶绯荤粺v1.106.exe", seed_b64=SEED, public_base_url=BASE,
            )
            self.assertTrue(out3.get("ok"), out3)
            self.assertEqual(int(out3["manifest"]["releaseSequence"]), 102)

    def test_new_sha_increases_seq(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            data_dir = Path(tmp)
            root = um._root(data_dir)
            (root / "release-manifest.json").write_text(
                json.dumps({"version": "1.87", "releaseSequence": 77, "sha256": "old"}, ensure_ascii=False),
                encoding="utf-8",
            )
            _write_pkg(root, "build-a", b"bytes-a", seq=102)
            out1 = um.publish_targeted_release(
                data_dir, version="1.106", build_id="build-a",
                target_client_ids=["aaaa" * 16], seed_b64=SEED, public_base_url=BASE,
            )
            self.assertEqual(int(out1["manifest"]["releaseSequence"]), 102)

            _write_pkg(root, "build-b", b"bytes-b", seq=102)
            out2 = um.publish_targeted_release(
                data_dir, version="1.107", build_id="build-b",
                target_client_ids=["bbbb" * 16], seed_b64=SEED, public_base_url=BASE,
            )
            self.assertTrue(out2.get("ok"), out2)
            self.assertGreaterEqual(int(out2["manifest"]["releaseSequence"]), 103)

    def test_seq_collision_different_sha_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            data_dir = Path(tmp)
            root = um._root(data_dir)
            (root / "release-manifest.json").write_text(
                json.dumps({"version": "1.87", "releaseSequence": 77, "sha256": "old"}, ensure_ascii=False),
                encoding="utf-8",
            )
            _write_pkg(root, "build-a", b"bytes-a", seq=102)
            out1 = um.publish_targeted_release(
                data_dir, version="1.106", build_id="build-a",
                target_client_ids=["aaaa" * 16], seed_b64=SEED, public_base_url=BASE, release_sequence=102,
            )
            self.assertTrue(out1.get("ok"), out1)

            _write_pkg(root, "build-b", b"bytes-b-different")
            out2 = um.publish_targeted_release(
                data_dir, version="1.107", build_id="build-b",
                target_client_ids=["bbbb" * 16], seed_b64=SEED, public_base_url=BASE, release_sequence=102,
            )
            self.assertFalse(out2.get("ok"), out2)
            self.assertEqual(out2.get("code"), "RELEASE_SEQUENCE_ARTIFACT_CONFLICT")

    def test_empty_targets_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            data_dir = Path(tmp)
            root = um._root(data_dir)
            _write_pkg(root, "build-a", b"bytes-a", seq=102)
            out = um.publish_targeted_release(
                data_dir, version="1.106", build_id="build-a",
                target_client_ids=[], seed_b64=SEED, public_base_url=BASE,
            )
            self.assertFalse(out.get("ok"))
            self.assertEqual(out.get("code"), "TARGET_CLIENT_IDS_REQUIRED")

    def test_same_artifact_seq_correction_upward_allowed(self) -> None:
        """Mis-labeled same SHA (e.g. 78) may be corrected upward to package seq 102."""
        with tempfile.TemporaryDirectory() as tmp:
            data_dir = Path(tmp)
            root = um._root(data_dir)
            (root / "release-manifest.json").write_text(
                json.dumps({"version": "1.87", "releaseSequence": 77, "sha256": "old"}, ensure_ascii=False),
                encoding="utf-8",
            )
            bid = "build-good"
            _write_pkg(root, bid, b"good-bytes", seq=0)
            first = um.publish_targeted_release(
                data_dir, version="1.106", build_id=bid,
                target_client_ids=["cccc" * 16], seed_b64=SEED, public_base_url=BASE, release_sequence=78,
            )
            self.assertEqual(int(first["manifest"]["releaseSequence"]), 78)
            # Correct to portable package sequence
            um.save_package_meta(data_dir, bid, "寰俊缇ゆ帶绯荤粺v1.106.exe", releaseSequence=102)
            second = um.publish_targeted_release(
                data_dir, version="1.106", build_id=bid,
                target_client_ids=["cccc" * 16], seed_b64=SEED, public_base_url=BASE, release_sequence=102,
            )
            self.assertTrue(second.get("ok"), second)
            self.assertEqual(int(second["manifest"]["releaseSequence"]), 102)


if __name__ == "__main__":
    unittest.main()

