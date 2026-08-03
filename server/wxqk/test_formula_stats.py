#!/usr/bin/env python3
"""Unit checks for siren formula stats aggregation (no network)."""
from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path


class FormulaStatsTest(unittest.TestCase):
    def setUp(self) -> None:
        self._td = tempfile.TemporaryDirectory()
        os.environ["SIREN_DATA"] = self._td.name
        os.environ.setdefault("SIREN_PASSWORD", "test-siren-password")
        os.environ.setdefault("SIREN_UPLOAD_TOKEN", "test-siren-upload-token")
        # Import after env so DATA_DIR picks up temp path.
        import importlib
        import server as srv

        importlib.reload(srv)
        self.srv = srv
        self.srv.ensure_dirs()

    def tearDown(self) -> None:
        try:
            import analytics_db as adb
            adb.close()
        except Exception:
            pass
        try:
            self._td.cleanup()
        except Exception:
            pass

    def test_place_and_settle_aggregate(self) -> None:
        rows = [
            {
                "t": "2026-07-23 10:00:00",
                "text": "下注成功：庄 20元，等待开奖",
                "kind": "自动",
                "clientId": "c1",
                "code": "PLACE_OK",
                "patternText": "庄庄闲闲",
                "patternHash": "庄2|闲2",
                "slot": 1,
                "simulated": False,
                "betTransactionId": "tx1",
                "betAmount": 20,
                "betSide": "庄",
            },
            {
                "t": "2026-07-23 10:00:01",
                "text": "transition PLACE_OK",
                "kind": "自动",
                "clientId": "c1",
                "code": "PLACE_OK",
                "patternText": "庄庄闲闲",
                "patternHash": "庄2|闲2",
                "slot": 1,
                "simulated": False,
                "betTransactionId": "tx1",
            },
            {
                "t": "2026-07-23 10:01:00",
                "text": "开奖结果：庄，本次赢",
                "kind": "自动",
                "clientId": "c1",
                "code": "SETTLE_OK",
                "patternText": "庄庄闲闲",
                "patternHash": "庄2|闲2",
                "slot": 1,
                "simulated": False,
                "gameResult": "WIN",
                "betTransactionId": "tx1",
            },
            {
                "t": "2026-07-23 10:02:00",
                "text": "模拟下注成功",
                "kind": "自动",
                "clientId": "c1",
                "code": "PLACE_OK",
                "patternText": "庄庄闲闲",
                "patternHash": "庄2|闲2",
                "slot": 1,
                "simulated": True,
                "betTransactionId": "tx2",
            },
            {
                "t": "2026-07-23 10:03:00",
                "text": "开奖结果：闲，本次输",
                "kind": "自动",
                "clientId": "c1",
                "code": "SETTLE_OK",
                "patternText": "庄庄闲闲",
                "patternHash": "庄2|闲2",
                "slot": 1,
                "simulated": True,
                "gameResult": "LOSE",
                "betTransactionId": "tx2",
            },
        ]
        n = self.srv.append_log("1.2.3.4", rows)
        self.assertEqual(n, 5)
        stats = self.srv.aggregate_formula_stats(ip="1.2.3.4")
        # Real and sim are separate primary rows (not mixed into one口径).
        self.assertEqual(len(stats["rows"]), 2)
        by_sim = {bool(r.get("simulated")): r for r in stats["rows"]}
        real = by_sim[False]
        sim = by_sim[True]
        self.assertEqual(real["formula"], "庄庄闲闲")
        self.assertEqual(real["placeReal"], 1)
        self.assertEqual(real["win"], 1)
        self.assertEqual(real["winRatePct"], 100.0)
        self.assertEqual(sim["placeSim"], 1)
        self.assertEqual(sim["lose"], 1)
        self.assertEqual(sim["winRatePct"], 0.0)
        self.assertTrue(Path(self.srv.FORMULA_EVENTS).exists())
        self.assertEqual(stats.get("source"), "analytics.db")

    def test_filter_by_client(self) -> None:
        self.srv.append_log("9.9.9.9", [{
            "text": "下注成功",
            "kind": "自动",
            "clientId": "aaa",
            "code": "PLACE_OK",
            "patternText": "闲闲",
            "slot": 2,
            "simulated": False,
            "betTransactionId": "t-a",
        }])
        self.srv.append_log("9.9.9.9", [{
            "text": "下注成功",
            "kind": "自动",
            "clientId": "bbb",
            "code": "PLACE_OK",
            "patternText": "庄庄",
            "slot": 1,
            "simulated": False,
            "betTransactionId": "t-b",
        }])
        a = self.srv.aggregate_formula_stats(client_id="aaa")
        self.assertEqual(len(a["rows"]), 1)
        self.assertEqual(a["rows"][0]["formula"], "闲闲")


if __name__ == "__main__":
    unittest.main()
