# -*- coding: utf-8 -*-
"""P0 security: mutate_policy concurrency, clientId, XFF, command queue ACK."""
from __future__ import annotations

import os
import tempfile
import threading
import unittest
from pathlib import Path

os.environ.setdefault("SIREN_PASSWORD", "test-siren-password")
os.environ.setdefault("FACAI888_SECURITY_MODE", "test")
# Shared upload token retired — do not require for tests.
os.environ.pop("SIREN_UPLOAD_TOKEN", None)
os.environ.pop("FACAI888_UPLOAD_TOKEN", None)


class FakeHandler:
    def __init__(self, peer: str, headers: dict[str, str] | None = None):
        self.client_address = (peer, 12345)
        self.headers = headers or {}


class SecurityP0Test(unittest.TestCase):
    def setUp(self) -> None:
        self._td = tempfile.TemporaryDirectory()
        self.data = Path(self._td.name)
        os.environ["SIREN_DATA"] = str(self.data)

        import importlib
        import security_db
        import command_queue
        import rate_limit

        security_db.close()
        importlib.reload(security_db)
        importlib.reload(command_queue)
        importlib.reload(rate_limit)
        security_db.configure(self.data)
        rate_limit.reset_for_tests()

        import server as srv

        importlib.reload(srv)
        self.srv = srv
        self.srv.DATA_DIR = self.data
        self.srv.POLICY_FILE = self.data / "run_policy.json"
        self.srv.CMD_DIR = self.data / "commands"
        self.srv.META_DIR = self.data / "clients"
        self.srv.LOG_DIR = self.data / "logs"
        self.srv.ANNOUNCE_DIR = self.data / "announces"
        self.srv.SHOT_DIR = self.data / "shots"
        self.srv.FORMULA_DIR = self.data / "formula"
        self.srv.ROAD_DIR = self.data / "roads"
        self.srv.SIM_BETS_DIR = self.data / "sim-bets"
        for p in (
            self.srv.CMD_DIR, self.srv.META_DIR, self.srv.LOG_DIR,
            self.srv.ANNOUNCE_DIR, self.srv.SHOT_DIR, self.srv.FORMULA_DIR,
            self.srv.ROAD_DIR, self.srv.SIM_BETS_DIR,
        ):
            p.mkdir(parents=True, exist_ok=True)
        self.srv._policy_cache = None
        self.srv._policy_mtime = None
        self.srv._online.clear()
        self.srv._TRUSTED_PROXIES_RAW = "127.0.0.1,::1"
        security_db.configure(self.data)

    def tearDown(self) -> None:
        try:
            import security_db
            security_db.close()
        except Exception:
            pass
        try:
            import analytics_db
            analytics_db.close()
        except Exception:
            pass
        try:
            self._td.cleanup()
        except Exception:
            pass

    def test_mutate_policy_concurrent_deny(self) -> None:
        errors: list[BaseException] = []

        def worker(i: int) -> None:
            try:
                def mut(pol: dict) -> None:
                    pol.setdefault("denyClients", {})[f"cid_{i:03d}"] = "batch"

                self.srv.mutate_policy(mut)
            except BaseException as e:  # noqa: BLE001
                errors.append(e)

        threads = [threading.Thread(target=worker, args=(i,)) for i in range(100)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=60)
        self.assertFalse(errors, errors)
        pol = self.srv.load_policy(force=True)
        self.assertEqual(len(pol.get("denyClients") or {}), 100)
        self.assertEqual(int(pol.get("policyEpoch") or 0), 100)

    def test_require_client_id_rejects_unknown(self) -> None:
        cid, err = self.srv.require_client_id("")
        self.assertIsNone(cid)
        self.assertEqual(err["message"], "missing_clientId")
        cid, err = self.srv.require_client_id("unknown")
        self.assertIsNone(cid)
        self.assertEqual(err["message"], "invalid_clientId")
        cid, err = self.srv.require_client_id("cid_ok_1")
        self.assertEqual(cid, "cid_ok_1")
        self.assertIsNone(err)

    def test_xff_ignored_from_untrusted_peer(self) -> None:
        h = FakeHandler("8.8.8.8", {"X-Forwarded-For": "1.2.3.4"})
        self.assertEqual(self.srv.client_ip(h), "8.8.8.8")
        h2 = FakeHandler("127.0.0.1", {"X-Forwarded-For": "1.2.3.4"})
        self.assertEqual(self.srv.client_ip(h2), "1.2.3.4")

    def test_revoke_not_overwritten_by_announce(self) -> None:
        import command_queue as cq

        cid2 = "device_b"
        cq.enqueue(cid2, "SHOW_ANNOUNCEMENT", {"text": "hello"}, policy_epoch=1)
        cq.enqueue(cid2, "REVOKE_RUNTIME", {"message": "stop"}, policy_epoch=2)
        first = cq.pop_next(cid2)
        self.assertIsNotNone(first)
        self.assertEqual(first.get("commandType"), "REVOKE_RUNTIME")
        second = cq.pop_next(cid2)
        self.assertIsNone(second)

    def test_refresh_supersedes_stale_revoke(self) -> None:
        import command_queue as cq

        cid = "device_refresh_super"
        cq.enqueue(cid, "REVOKE_RUNTIME", {"message": "stop"}, policy_epoch=2)
        cq.enqueue(cid, "REFRESH_POLICY", {}, policy_epoch=3)
        first = cq.pop_next(cid)
        self.assertIsNotNone(first)
        self.assertEqual(first.get("commandType"), "REFRESH_POLICY")
        self.assertIsNone(cq.pop_next(cid))

    def test_start_desktop_coalesces_pending_starts(self) -> None:
        import command_queue as cq
        import security_db as sdb

        cid = "device_start_coalesce"
        cq.enqueue(cid, "START_DESKTOP", {"continuous": True}, policy_epoch=1)
        cq.enqueue(cid, "START_DESKTOP", {"continuous": True, "forceRestart": True}, policy_epoch=1)
        cq.enqueue(cid, "START_DESKTOP", {"continuous": True, "kick": True}, policy_epoch=1)
        first = cq.pop_next(cid)
        self.assertIsNotNone(first)
        self.assertEqual(first.get("commandType"), "START_DESKTOP")
        self.assertTrue(first.get("kick") or first.get("forceRestart"))
        self.assertIsNone(cq.pop_next(cid))
        conn = sdb.get_conn()
        expired = conn.execute(
            "SELECT count(*) FROM device_commands WHERE device_id=? AND status='EXPIRED' AND command_type='START_DESKTOP'",
            (cid,),
        ).fetchone()[0]
        self.assertGreaterEqual(int(expired), 2)

    def test_command_ack(self) -> None:
        import command_queue as cq

        cid = "device_ack"
        enq = cq.enqueue(cid, "REFRESH_POLICY", {}, policy_epoch=3)
        cmd = cq.pop_next(cid)
        self.assertEqual(cmd["commandId"], enq["commandId"])
        ack = cq.ack(cid, cmd["commandId"], status="APPLIED")
        self.assertTrue(ack.get("ok"))
        dup = cq.ack(cid, cmd["commandId"], status="APPLIED")
        self.assertTrue(dup.get("duplicate"))

    def test_admin_token_ttl_default_24h(self) -> None:
        self.assertEqual(self.srv.TOKEN_TTL, 24 * 3600)
        self.assertGreaterEqual(self.srv.TOKEN_TTL, 12 * 3600)

    def test_admin_token_sliding_renew(self) -> None:
        tok = self.srv.make_admin_token()
        self.assertTrue(self.srv.check_admin_token(tok))
        # Fresh token should not renew yet (still above half-life).
        self.assertEqual(self.srv.maybe_renew_admin_token(tok), "")
        # Force near-expiry by crafting an almost-expired valid token.
        import hmac
        import hashlib
        exp = int(self.srv.now_ts()) + 60
        nonce = "abcd1234abcd1234"
        raw = f"{exp}.{nonce}"
        sig = hmac.new(self.srv.TOKEN_SECRET, raw.encode(), hashlib.sha256).hexdigest()[:32]
        near = f"{raw}.{sig}"
        self.assertTrue(self.srv.check_admin_token(near))
        renewed = self.srv.maybe_renew_admin_token(near)
        self.assertTrue(renewed)
        self.assertTrue(self.srv.check_admin_token(renewed))
        self.assertNotEqual(renewed, near)

    def test_admin_refresh_requires_valid_token(self) -> None:
        self.assertFalse(self.srv.check_admin_token(""))
        self.assertFalse(self.srv.check_admin_token("not.a.token"))
        self.assertEqual(self.srv.maybe_renew_admin_token("bad"), "")

    def test_admin_token_old_still_valid_after_renew(self) -> None:
        import hmac
        import hashlib
        exp = int(self.srv.now_ts()) + 60
        nonce = "eeee1111eeee1111"
        raw = f"{exp}.{nonce}"
        sig = hmac.new(self.srv.TOKEN_SECRET, raw.encode(), hashlib.sha256).hexdigest()[:32]
        near = f"{raw}.{sig}"
        renewed = self.srv.maybe_renew_admin_token(near)
        self.assertTrue(renewed)
        # Old near-expiry token remains valid until its own exp.
        self.assertTrue(self.srv.check_admin_token(near))
        self.assertTrue(self.srv.check_admin_token(renewed))

    def test_admin_concurrent_renew_tokens_all_valid(self) -> None:
        import hmac
        import hashlib
        import concurrent.futures

        def near_token(i: int) -> str:
            exp = int(self.srv.now_ts()) + 90
            nonce = f"{i:016x}"
            raw = f"{exp}.{nonce}"
            sig = hmac.new(self.srv.TOKEN_SECRET, raw.encode(), hashlib.sha256).hexdigest()[:32]
            return f"{raw}.{sig}"

        seeds = [near_token(i) for i in range(8)]
        for s in seeds:
            self.assertTrue(self.srv.check_admin_token(s))

        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as ex:
            renewed = list(ex.map(self.srv.maybe_renew_admin_token, seeds))
        for old, new in zip(seeds, renewed):
            self.assertTrue(new)
            self.assertTrue(self.srv.check_admin_token(new))
            self.assertTrue(self.srv.check_admin_token(old))
            self.assertNotEqual(new, old)

    def test_cors_exposes_admin_token_renew_header(self) -> None:
        from pathlib import Path
        src = Path(__file__).with_name("server.py").read_text(encoding="utf-8")
        self.assertIn("Access-Control-Expose-Headers", src)
        self.assertIn("X-Admin-Token-Renew", src)

    def test_login_rate_limit(self) -> None:
        import rate_limit as rl

        rl.reset_for_tests()
        ip = "9.9.9.9"
        for _ in range(8):
            rl.record_login_failure(ip)
        gate = rl.check_login_allowed(ip)
        self.assertFalse(gate.get("ok"))


if __name__ == "__main__":
    unittest.main()
