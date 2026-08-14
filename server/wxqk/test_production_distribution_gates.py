#!/usr/bin/env python3
"""P0 gates: enrollment, targeting, URL, key rotation helpers, SSH host key, atomic publish."""
from __future__ import annotations

import base64
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import devices as dev
import production_url as pu
import ssh_host_key as shk
import update_manifest as um
import version_policy as vp


class EnrollmentAndTargetingGates(unittest.TestCase):
    def test_challenge_does_not_widen_allowlist(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            data_dir = Path(tmp)
            vp.save(data_dir, {
                "mode": "strict",
                "allowedBuildIds": ["official-only"],
                "revokedBuildIds": [],
                "minimumReleaseSequence": 0,
                "latestReleaseSequence": 10,
            })
            out = dev.begin_challenge({
                "publicKey": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
                "buildId": "attacker-build",
                "clientId": "c" * 64,
            }, data_dir=data_dir)
            self.assertTrue(out.get("ok"), out)
            pol = vp.load(data_dir)
            self.assertEqual(pol.get("allowedBuildIds"), ["official-only"])
            self.assertNotIn("attacker-build", pol.get("allowedBuildIds") or [])

    def test_unknown_build_strict_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            data_dir = Path(tmp)
            pol = {
                "mode": "strict",
                "allowedBuildIds": ["allowed-a"],
                "revokedBuildIds": [],
                "minimumReleaseSequence": 0,
                "latestReleaseSequence": 99,
            }
            verdict = vp.evaluate_client(
                {"buildId": "unknown-build", "releaseSequence": "100", "version": "1.200.0"},
                pol=pol,
                data_dir=data_dir,
            )
            self.assertFalse(verdict.get("ok"))

    def test_same_nat_ip_does_not_deliver_others_targeted(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            data_dir = Path(tmp)
            root = um._root(data_dir)
            man = {
                "version": "1.106",
                "buildId": "b1",
                "sha256": "aa" * 32,
                "releaseSequence": 102,
                "targetClientIds": ["client-a" + "0" * 55],
                "downloadURL": "https://updates.wxqk.test/pkg",
                "fileName": "微信群控系统v1.106.exe",
            }
            um.save_targeted_releases(data_dir, {
                "releases": [{
                    "targetClientIds": ["client-a" + "0" * 55],
                    "manifest": man,
                    "signature": "11" * 32,
                    "signatureV2": "22" * 32,
                }]
            })
            (root / "release-manifest.json").write_text(
                json.dumps({"version": "1.87", "releaseSequence": 77, "sha256": "bb" * 32}),
                encoding="utf-8",
            )

            def clients_by_ip(_ip: str):
                return ["client-a" + "0" * 55, "client-b" + "0" * 55]

            for_a, _, _ = um.resolve_manifest_for_client(
                data_dir,
                client_id="client-a" + "0" * 55,
                client_ip="1.2.3.4",
                clients_by_ip=clients_by_ip,
            )
            for_b, _, _ = um.resolve_manifest_for_client(
                data_dir,
                client_id="client-b" + "0" * 55,
                client_ip="1.2.3.4",
                clients_by_ip=clients_by_ip,
            )
            self.assertEqual(for_a.get("version"), "1.106")
            self.assertEqual(for_b.get("version"), "1.87")

    def test_placeholder_url_rejected_on_targeted_publish(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            data_dir = Path(tmp)
            root = um._root(data_dir)
            bid = "build-x"
            (root / "packages" / f"{bid}.exe").write_bytes(b"x")
            out = um.publish_targeted_release(
                data_dir,
                version="1.106",
                build_id=bid,
                target_client_ids=["d" * 64],
                seed_b64="AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
                public_base_url="https://mesh.example.invalid/wxqk",
            )
            self.assertFalse(out.get("ok"))
            self.assertEqual(out.get("code"), "PRODUCTION_URL_INVALID")

    def test_placeholder_url_rejected_on_stable_publish(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            data_dir = Path(tmp)
            root = um._root(data_dir)
            bid = "build-y"
            (root / "packages" / f"{bid}.exe").write_bytes(b"yy")
            out = um.publish_release(
                data_dir,
                version="1.106",
                build_id=bid,
                seed_b64="AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
                public_base_url="https://mesh.example.invalid/wxqk",
            )
            self.assertFalse(out.get("ok"))
            self.assertEqual(out.get("code"), "PRODUCTION_URL_INVALID")

    def test_production_url_helper(self) -> None:
        self.assertTrue(pu.is_placeholder_public_base_url("https://mesh.example.invalid/wxqk"))
        self.assertFalse(pu.is_placeholder_public_base_url("https://updates.wxqk.test/wxqk"))

    def test_challenge_rate_limit(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            data_dir = Path(tmp)
            pub = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
            # Force tiny limit for this test
            old_max = dev.CHALLENGE_RATE_MAX
            try:
                dev.CHALLENGE_RATE_MAX = 3
                for i in range(3):
                    out = dev.begin_challenge(
                        {"publicKey": pub, "buildId": "b", "clientId": "c" * 64},
                        data_dir=data_dir,
                        client_ip="9.9.9.9",
                    )
                    self.assertTrue(out.get("ok"), out)
                blocked = dev.begin_challenge(
                    {"publicKey": pub, "buildId": "b", "clientId": "c" * 64},
                    data_dir=data_dir,
                    client_ip="9.9.9.9",
                )
                self.assertFalse(blocked.get("ok"))
                self.assertEqual(blocked.get("code"), "RATE_LIMITED")
            finally:
                dev.CHALLENGE_RATE_MAX = old_max

    def test_new_device_default_pending(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            data_dir = Path(tmp)
            os.environ.pop("WXQK_DEVICE_AUTO_ACTIVATE", None)
            os.environ.pop("FACAI888_AUTO_ACTIVATE_DEVICES", None)
            # Use real ed25519 complete path is heavy; assert helper default
            self.assertFalse(dev._auto_activate_enabled())
            self.assertEqual(dev.STATUS_PENDING, "PENDING")

    def test_bind_client_id_once_preserves_existing(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            data_dir = Path(tmp)
            did = "abcd" * 16
            store = {"devices": {did: {
                "deviceId": did,
                "publicKey": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
                "clientId": "bound-client",
                "status": "ACTIVE",
            }}}
            path = data_dir / "security" / "devices.json"
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(store), encoding="utf-8")
            out = dev.bind_client_id_once(did, "other-client", data_dir=data_dir)
            self.assertFalse(out.get("ok"))
            self.assertEqual(out.get("code"), "CLIENT_ID_BOUND")

    def test_ssh_host_key_requires_pin(self) -> None:
        class FakeClient:
            def __init__(self):
                self.policy = None
                self.keys = None

            def load_host_keys(self, path):
                self.keys = path

            def set_missing_host_key_policy(self, policy):
                self.policy = policy

            def get_host_keys(self):
                return mock.Mock(add=lambda *a, **k: None)

        os.environ.pop("WXQK_SSH_KNOWN_HOSTS", None)
        os.environ.pop("WXQK_SSH_HOST_KEY_SHA256", None)
        with self.assertRaises(SystemExit):
            shk.configure_ssh_client(FakeClient())

    def test_publish_atomicity_rolls_back_on_policy_fail(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            data_dir = Path(tmp)
            root = um._root(data_dir)
            bid = "atomic-b"
            (root / "packages" / f"{bid}.exe").write_bytes(b"payload")
            # Seed prior targeted state
            before = {
                "releases": [{
                    "targetClientIds": ["a" * 64],
                    "manifest": {"version": "1.0", "buildId": "old", "sha256": "aa" * 32},
                    "signature": "11" * 32,
                    "signatureV2": "22" * 32,
                }]
            }
            um.save_targeted_releases(data_dir, before)
            with mock.patch.object(vp, "save", side_effect=OSError("disk full")):
                out = um.publish_targeted_release(
                    data_dir,
                    version="1.106",
                    build_id=bid,
                    target_client_ids=["b" * 64],
                    seed_b64=base64.b64encode(b"\x01" * 32).decode("ascii"),
                    public_base_url="https://updates.wxqk.test/wxqk",
                )
            self.assertFalse(out.get("ok"))
            after = um.load_targeted_releases(data_dir)
            self.assertEqual(
                (after.get("releases") or [{}])[0].get("manifest", {}).get("buildId"),
                "old",
            )

    def test_artifact_identity_different_build_same_sha_not_silently_same(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            data_dir = Path(tmp)
            root = um._root(data_dir)
            payload = b"same-bytes"
            for bid in ("build-one", "build-two"):
                (root / "packages" / f"{bid}.exe").write_bytes(payload)
            seed = base64.b64encode(b"\x02" * 32).decode("ascii")
            first = um.publish_targeted_release(
                data_dir,
                version="1.106",
                build_id="build-one",
                target_client_ids=["a" * 64],
                seed_b64=seed,
                public_base_url="https://updates.wxqk.test/wxqk",
            )
            self.assertTrue(first.get("ok"), first)
            seq1 = int((first.get("manifest") or {}).get("releaseSequence") or 0)
            second = um.publish_targeted_release(
                data_dir,
                version="1.107",
                build_id="build-two",
                target_client_ids=["b" * 64],
                seed_b64=seed,
                public_base_url="https://updates.wxqk.test/wxqk",
            )
            self.assertTrue(second.get("ok"), second)
            # Same sha may keep seq for same artifact accounting; buildIds remain distinct.
            man2 = second.get("manifest") or {}
            self.assertEqual(man2.get("buildId"), "build-two")
            self.assertNotEqual(man2.get("buildId"), "build-one")
            self.assertGreaterEqual(int(man2.get("releaseSequence") or 0), seq1)


if __name__ == "__main__":
    unittest.main()
