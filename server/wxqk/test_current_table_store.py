#!/usr/bin/env python3
"""Unit tests for current_table_store."""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from current_table_store import CurrentTableStore, normalize_result


class TestNormalizeResult(unittest.TestCase):
    def test_map(self):
        self.assertEqual(normalize_result("B"), "BANKER")
        self.assertEqual(normalize_result("庄"), "BANKER")
        self.assertEqual(normalize_result("P"), "PLAYER")
        self.assertEqual(normalize_result("闲"), "PLAYER")
        self.assertEqual(normalize_result("T"), "TIE")
        self.assertEqual(normalize_result("和"), "TIE")
        self.assertEqual(normalize_result("???"), "UNKNOWN")


class TestCurrentTableStore(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = CurrentTableStore(Path(self.tmp.name))

    def tearDown(self):
        self.tmp.cleanup()

    def test_enter_and_get(self):
        r = self.store.upsert_table_state({
            "userId": "hash1",
            "clientInstanceId": "cid_1",
            "sourceId": "facai888",
            "tableId": "100",
            "tableName": "桌A",
            "shoeId": "boot9",
            "tableStatus": "ENTERED",
            "online": True,
            "isCurrentTable": True,
            "currentRoad": [
                {"roundId": "R1", "roundIndex": 1, "result": "B"},
                {"roundId": "R2", "roundIndex": 2, "result": "闲"},
            ],
            "latestResult": "PLAYER",
        })
        self.assertTrue(r["ok"])
        got = self.store.get_current_table(client_instance_id="cid_1")
        self.assertTrue(got["found"])
        cur = got["current"]
        self.assertEqual(cur["tableId"], "100")
        self.assertEqual(cur["shoeId"], "boot9")
        self.assertEqual(len(cur["currentRoad"]), 2)
        self.assertEqual(cur["currentRoad"][0]["result"], "BANKER")
        self.assertEqual(cur["currentRoad"][1]["result"], "PLAYER")

    def test_heartbeat_no_wipe_road(self):
        self.store.upsert_table_state({
            "userId": "hash1",
            "clientInstanceId": "cid_1",
            "tableId": "100",
            "shoeId": "b1",
            "tableStatus": "ENTERED",
            "online": True,
            "currentRoad": [{"roundId": "R1", "result": "BANKER"}],
        })
        self.store.upsert_table_state({
            "kind": "heartbeat",
            "userId": "hash1",
            "clientInstanceId": "cid_1",
            "tableId": "100",
            "shoeId": "b1",
            "lastRoundId": "R1",
            "online": True,
        })
        cur = self.store.get_current_table(client_instance_id="cid_1")["current"]
        self.assertEqual(len(cur.get("currentRoad") or []), 1)

    def test_leave_offline(self):
        self.store.upsert_table_state({
            "userId": "hash1",
            "clientInstanceId": "cid_1",
            "tableId": "100",
            "shoeId": "b1",
            "tableStatus": "ENTERED",
            "online": True,
        })
        self.store.upsert_table_state({
            "userId": "hash1",
            "clientInstanceId": "cid_1",
            "tableId": "100",
            "shoeId": "b1",
            "tableStatus": "LEFT",
            "online": False,
            "isCurrentTable": False,
        })
        cur = self.store.get_current_table(client_instance_id="cid_1")["current"]
        self.assertFalse(cur["online"])
        self.assertEqual(cur["tableId"], "100")

    def test_round_dedupe_and_conflict(self):
        base = {
            "userId": "hash1",
            "clientInstanceId": "cid_1",
            "sourceId": "facai888",
            "tableId": "100",
            "shoeId": "b1",
            "roundId": "R9",
            "roundIndex": 9,
            "result": "BANKER",
            "eventTime": "2026-07-25T12:00:00+08:00",
        }
        a = self.store.ingest_round_event(base)
        self.assertEqual(a["accepted"], 1)
        b = self.store.ingest_round_event(base)
        self.assertEqual(b["accepted"], 0)
        self.assertTrue(b.get("deduped"))
        c = self.store.ingest_round_event({**base, "result": "PLAYER"})
        self.assertEqual(c["accepted"], 0)
        self.assertTrue(c.get("conflict"))
        hist = self.store.get_shoe_history(table_id="100", shoe_id="b1")
        self.assertEqual(hist["count"], 1)
        self.assertEqual(hist["rounds"][0]["result"], "BANKER")

    def test_shoe_isolation(self):
        self.store.ingest_round_event({
            "userId": "u",
            "clientInstanceId": "c",
            "tableId": "1",
            "shoeId": "bootA",
            "roundId": "R1",
            "result": "B",
        })
        self.store.ingest_round_event({
            "userId": "u",
            "clientInstanceId": "c",
            "tableId": "1",
            "shoeId": "bootB",
            "roundId": "R1",
            "result": "P",
        })
        a = self.store.get_shoe_history(table_id="1", shoe_id="bootA")
        b = self.store.get_shoe_history(table_id="1", shoe_id="bootB")
        self.assertEqual(a["count"], 1)
        self.assertEqual(b["count"], 1)
        self.assertEqual(a["rounds"][0]["result"], "BANKER")
        self.assertEqual(b["rounds"][0]["result"], "PLAYER")

    def test_lookup_by_user(self):
        self.store.upsert_table_state({
            "userId": "hashX",
            "clientInstanceId": "cid_x",
            "tableId": "55",
            "shoeId": "s",
            "tableStatus": "ENTERED",
            "online": True,
        })
        got = self.store.get_current_table(user_id="hashX")
        self.assertTrue(got["found"])
        self.assertEqual(got["current"]["tableId"], "55")


if __name__ == "__main__":
    unittest.main()
