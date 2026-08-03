#!/usr/bin/env python3
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from sim_bets import SimBetsStore


class SimBetsStoreTest(unittest.TestCase):
    def test_ingest_idempotent_summary_and_pages(self):
        with tempfile.TemporaryDirectory() as td:
            store = SimBetsStore(Path(td))
            r1 = store.ingest(
                client_id="cid_1",
                account="ab***yz",
                summary={
                    "sessionId": "sim-aaa",
                    "startedAt": 1000,
                    "win": 1,
                    "lose": 2,
                    "tie": 0,
                    "pending": 0,
                    "currentLoseStreak": 2,
                    "maxLoseStreak": 2,
                    "savedAt": 2000,
                },
                events=[
                    {"id": "e1", "sessionId": "sim-aaa", "gameResult": "WIN", "createdAt": "t1"},
                    {"id": "e2", "sessionId": "sim-aaa", "gameResult": "LOSE", "createdAt": "t2"},
                    {"id": "e3", "sessionId": "sim-aaa", "gameResult": "LOSE", "createdAt": "t3"},
                ],
            )
            self.assertTrue(r1["ok"])
            self.assertEqual(r1["accepted"], 3)

            # Duplicate events must not inflate accepted / file
            r2 = store.ingest(
                client_id="cid_1",
                events=[
                    {"id": "e1", "sessionId": "sim-aaa", "gameResult": "WIN"},
                    {"id": "e4", "sessionId": "sim-aaa", "gameResult": "TIE"},
                ],
                summary={
                    "sessionId": "sim-aaa",
                    "win": 1,
                    "lose": 2,
                    "tie": 1,
                    "maxLoseStreak": 2,
                    "savedAt": 3000,
                },
            )
            self.assertEqual(r2["accepted"], 1)

            summary = store.get_summary("cid_1")
            self.assertTrue(summary["ok"])
            self.assertFalse(summary.get("empty"))
            self.assertEqual(summary["sessionId"], "sim-aaa")
            self.assertEqual(summary["tie"], 1)
            self.assertEqual(summary["eventCount"], 4)
            self.assertEqual(summary["maxLoseStreak"], 2)

            p1 = store.query_events(client_id="cid_1", page=1, page_size=2)
            self.assertTrue(p1["ok"])
            self.assertEqual(p1["total"], 4)
            self.assertEqual(len(p1["rows"]), 2)
            self.assertTrue(p1["hasMore"])
            # Newest first
            self.assertEqual(p1["rows"][0]["id"], "e4")

            p2 = store.query_events(client_id="cid_1", page=2, page_size=2)
            self.assertEqual(len(p2["rows"]), 2)
            self.assertFalse(p2["hasMore"])

    def test_empty_summary(self):
        with tempfile.TemporaryDirectory() as td:
            store = SimBetsStore(Path(td))
            s = store.get_summary("nobody")
            self.assertTrue(s["ok"])
            self.assertTrue(s.get("empty"))

    def test_account_hash_isolation_soft_legacy(self):
        with tempfile.TemporaryDirectory() as td:
            store = SimBetsStore(Path(td))
            # Legacy write (no hash) remains readable.
            store.ingest(
                client_id="cid_x",
                account="ab***yz",
                summary={
                    "sessionId": "legacy",
                    "win": 3,
                    "lose": 1,
                    "tie": 0,
                    "savedAt": 1000,
                },
                events=[{"id": "L1", "sessionId": "legacy", "gameResult": "WIN"}],
            )
            soft = store.get_summary("cid_x", account_hash="abc123")
            self.assertFalse(soft.get("empty"))
            self.assertEqual(soft["win"], 3)

            # New hash write is isolated from a different hash.
            store.ingest(
                client_id="cid_x",
                account="cd***uv",
                account_hash="fff999",
                summary={
                    "sessionId": "hashed",
                    "win": 9,
                    "lose": 0,
                    "tie": 0,
                    "accountHash": "fff999",
                    "savedAt": 2000,
                },
                events=[{"id": "H1", "sessionId": "hashed", "gameResult": "WIN"}],
            )
            a = store.get_summary("cid_x", account_hash="fff999")
            b = store.get_summary("cid_x", account_hash="eee888")
            self.assertEqual(a["win"], 9)
            # Different hash must not see the hashed account's counters.
            self.assertTrue(b.get("empty") or b.get("win") != 9)


if __name__ == "__main__":
    unittest.main()
