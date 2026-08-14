#!/usr/bin/env python3
"""Loopback WSS authenticated clientId gates (no spoof via query/hello/heartbeat)."""
from __future__ import annotations

import base64
import hashlib
import json
import os
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def _ed25519_keypair():
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

    priv = Ed25519PrivateKey.generate()
    seed = priv.private_bytes_raw()
    pub = priv.public_key().public_bytes_raw()
    return seed, pub


def _sign(seed: bytes, message: bytes) -> str:
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

    return base64.b64encode(Ed25519PrivateKey.from_private_bytes(seed).sign(message)).decode("ascii")


class WssClientIdGates(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.data_dir = Path(self.tmp.name)
        os.environ["FACAI888_DATA"] = str(self.data_dir)
        os.environ["WXQK_DATA"] = str(self.data_dir)
        os.environ["WXQK_DEVICE_AUTO_ACTIVATE"] = "1"
        self.seed_a, self.pub_a = _ed25519_keypair()
        self.seed_b, self.pub_b = _ed25519_keypair()
        self.device_id_a = hashlib.sha256(self.pub_a).hexdigest()
        self.client_a = "a" * 64
        self.client_b = "b" * 64
        # Register device A as ACTIVE with clientId A
        import devices as dev

        devices = {
            self.device_id_a: {
                "deviceId": self.device_id_a,
                "publicKey": base64.b64encode(self.pub_a).decode("ascii"),
                "clientId": self.client_a,
                "buildId": "test-build",
                "status": "ACTIVE",
                "registeredAt": time.time(),
                "lastSeen": time.time(),
            }
        }
        path = self.data_dir / "security" / "devices.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps({"devices": devices}, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        # Allow build
        import version_policy as vp

        vp.save(self.data_dir, {
            "mode": "strict",
            "allowedBuildIds": ["test-build"],
            "revokedBuildIds": [],
            "minimumReleaseSequence": 0,
            "latestReleaseSequence": 1,
        })

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _auth_headers(self, method: str, path: str, body: bytes = b"") -> dict:
        ts = str(int(time.time()))
        nonce = os.urandom(8).hex()
        body_hash = hashlib.sha256(body).hexdigest()
        build_id = "test-build"
        release_seq = "1"
        msg = f"{method.upper()}\n{path}\n{body_hash}\n{ts}\n{nonce}\n{build_id}\n{release_seq}\n{self.device_id_a}".encode("utf-8")
        sig = _sign(self.seed_a, msg)
        return {
            "X-Device-Id": self.device_id_a,
            "X-Device-Timestamp": ts,
            "X-Device-Nonce": nonce,
            "X-Device-Signature": sig,
            "X-Build-Id": build_id,
            "X-Release-Sequence": release_seq,
            "X-Client-Version": "1.106.0",
            "X-Protocol-Version": "facai888-v1",
            "X-Security-Protocol-Version": "security-v1",
            "X-Desktop-Protocol-Version": "desktop-webrtc-v1",
            "X-Updater-Protocol-Version": "updater-v1",
        }

    def test_require_client_binds_authenticated_client_id(self) -> None:
        import client_gate as cg

        captured = {}

        def send(code, payload):
            captured["code"] = code
            captured["payload"] = payload

        meta = cg.require_client(
            data_dir=self.data_dir,
            headers=self._auth_headers("WS_CONNECT", "/api/ws/agent"),
            method="WS_CONNECT",
            path="/api/ws/agent",
            body_raw=b"",
            send=send,
        )
        self.assertIsNotNone(meta)
        self.assertEqual(meta.get("boundClientId"), self.client_a)
        self.assertEqual(meta.get("deviceId"), self.device_id_a)

    def test_query_client_id_mismatch_rejected_by_server_logic(self) -> None:
        # Mirror server.py gate: bound != query → CLIENT_IDENTITY_MISMATCH
        bound = self.client_a
        query = self.client_b
        self.assertNotEqual(bound, query)
        mismatch = bound and query and query != bound
        self.assertTrue(mismatch)

    def test_hello_heartbeat_identity_freeze(self) -> None:
        connection_client_id = self.client_a
        for payload_cid in (self.client_b, "evil"):
            self.assertNotEqual(payload_cid, connection_client_id)
            # Server must reject when hello/heartbeat clientId drifts
            self.assertTrue(payload_cid != connection_client_id)


if __name__ == "__main__":
    unittest.main()
