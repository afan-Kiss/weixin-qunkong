#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Concurrent SQLite / dual-write / quality grade table tests."""
from __future__ import annotations

import tempfile
import threading
import unittest
from pathlib import Path

import analytics_db as adb
from analytics_stats import benjamini_hochberg, bootstrap_by_boots, walk_forward_days, wilson_interval
from formula_events import ingest_formula_events
from road_quality import grade_quality


class ConcurrentAnalyticsTest(unittest.TestCase):
    def setUp(self):
        self._td = tempfile.TemporaryDirectory()
        adb.close()
        adb.configure(Path(self._td.name))
        adb.get_conn()

    def tearDown(self):
        adb.close()
        try:
            self._td.cleanup()
        except Exception:
            pass

    def test_wilson_edge_cases(self):
        for w, l in [(0, 0), (1, 0), (5, 5), (55, 45), (500, 500)]:
            r = wilson_interval(w, l)
            if w + l == 0:
                self.assertIsNone(r["rawWinRate"])
            else:
                self.assertTrue(0 <= r["wilsonLower"] <= r["wilsonUpper"] <= 1)
                self.assertFalse(r["wilsonLower"] != r["wilsonLower"])  # not NaN

    def test_fdr_fixed(self):
        rows = benjamini_hochberg([0.001, 0.01, 0.03, 0.2])
        self.assertTrue(rows[0]["fdrSignificant"])
        self.assertFalse(rows[3]["fdrSignificant"])
        self.assertTrue(all(r["qValue"] is not None for r in rows))
        self.assertLessEqual(rows[0]["qValue"], rows[3]["qValue"] + 1e-9)

    def test_bootstrap_seed_stable(self):
        boots = [{"win": 3, "lose": 2, "stake": 5, "profit": 1} for _ in range(8)]
        a = bootstrap_by_boots(boots, samples=200, seed=20260724)
        b = bootstrap_by_boots(boots, samples=200, seed=20260724)
        self.assertEqual(a, b)
        tiny = bootstrap_by_boots(boots[:3])
        self.assertEqual(tiny["bootstrapSamples"], 0)

    def test_walk_forward_no_leak(self):
        days = [{"day": f"2026-07-{i:02d}", "win": 1, "lose": 1, "stake": 2, "profit": 0} for i in range(1, 15)]
        wf = walk_forward_days(days)
        self.assertGreater(wf["walkForwardWindowCount"], 0)
        for w in wf.get("walkForwardWindows") or []:
            self.assertLess(w["trainTo"], w["testFrom"])

    def test_quality_matrix(self):
        cases = [
            (dict(boot_no="B1", continuity_ok=True, geometry_verified=True, classification_verified=True,
                  consensus_client_count=2, source_client_count=2), "A"),
            (dict(boot_no="B1", continuity_ok=True, geometry_verified=True, classification_verified=True,
                  consensus_client_count=1, source_client_count=1), "B"),
            (dict(boot_no="_", continuity_ok=True, geometry_verified=True, classification_verified=True,
                  consensus_client_count=2, source_client_count=2), "C"),
            (dict(boot_no="B1", continuity_ok=True, geometry_verified=False, classification_verified=True,
                  consensus_client_count=2, source_client_count=2), "C"),
            (dict(boot_no="B1", continuity_ok=True, geometry_verified=True, classification_verified=True,
                  consensus_client_count=1, source_client_count=2, conflict=True), "D"),
            (dict(boot_no="B1", continuity_ok=True, geometry_verified=True, classification_verified=True,
                  consensus_client_count=1, source_client_count=1, legacy=True), "C"),
        ]
        for kwargs, expect in cases:
            q, _ = grade_quality(**kwargs)
            self.assertEqual(q, expect, kwargs)

    def test_concurrent_formula_insert_dedupe(self):
        barrier = threading.Barrier(10)
        results = []

        def worker(i):
            barrier.wait()
            ev = {
                "eventId": "same-event-id",
                "code": "PLACE_OK",
                "formulaId": "庄2|闲2",
                "patternHash": "庄2|闲2",
                "slot": 1,
                "clientId": f"c{i}",
                "betTransactionId": "tx-same",
                "simulated": False,
            }
            results.append(ingest_formula_events([ev]))

        threads = [threading.Thread(target=worker, args=(i,)) for i in range(10)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        inserted = sum(int(r.get("inserted") or 0) for r in results)
        self.assertEqual(inserted, 1)
        n = adb.get_conn().execute("SELECT COUNT(*) FROM formula_events WHERE event_id='same-event-id'").fetchone()[0]
        self.assertEqual(n, 1)

    def test_concurrent_stats_reads(self):
        for i in range(20):
            ingest_formula_events([{
                "code": "PLACE_OK",
                "formulaId": f"f{i%3}",
                "patternHash": f"f{i%3}",
                "slot": 1,
                "clientId": "c",
                "betTransactionId": f"tx{i}",
                "simulated": False,
                "eventId": f"e{i}",
            }])
        errs = []

        def reader():
            try:
                from formula_events import aggregate_from_db
                aggregate_from_db()
            except Exception as e:
                errs.append(str(e))

        threads = [threading.Thread(target=reader) for _ in range(5)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(errs, [])
        self.assertEqual(adb.integrity_check(), "ok")

    def test_partial_invalid_batch(self):
        r = ingest_formula_events([
            {"code": "PLACE_OK", "formulaId": "庄2", "eventId": "ok1", "betTransactionId": "t1"},
            {"code": "NOPE", "formulaId": "庄2", "eventId": "bad"},
            {"code": "PLACE_OK", "formulaId": "", "eventId": "bad2"},
            {"code": "PLACE_OK", "formulaId": "庄2", "eventId": "ok1", "betTransactionId": "t1"},
        ])
        self.assertEqual(r["inserted"], 1)
        self.assertEqual(r["invalid"], 2)
        self.assertEqual(r["duplicate"], 1)

    def test_dual_write_authority_contract(self):
        from formula_events import finalize_ingest_response

        ok_sqlite = ingest_formula_events([{
            "code": "PLACE_OK",
            "formulaId": "庄2|闲2",
            "eventId": "dw1",
            "betTransactionId": "tx-dw1",
            "simulated": False,
        }])
        both_ok = finalize_ingest_response(ok_sqlite, jsonl_failed=0)
        self.assertTrue(both_ok["ok"])
        self.assertEqual(both_ok["inserted"], 1)
        self.assertEqual(both_ok["jsonlFailed"], 0)

        sqlite_ok_jsonl_fail = finalize_ingest_response(ok_sqlite, jsonl_failed=1)
        self.assertTrue(sqlite_ok_jsonl_fail["ok"])
        self.assertEqual(sqlite_ok_jsonl_fail["inserted"], 1)
        self.assertEqual(sqlite_ok_jsonl_fail["jsonlFailed"], 1)

        sqlite_fail = {
            "ok": False,
            "received": 1,
            "inserted": 0,
            "duplicate": 0,
            "invalid": 1,
            "message": "no_valid_events",
        }
        fail_out = finalize_ingest_response(sqlite_fail, jsonl_failed=0)
        self.assertFalse(fail_out["ok"])
        self.assertEqual(fail_out["jsonlFailed"], 0)

        # same eventId re-upload → duplicate, still ok (client must not infinite-retry)
        dup = ingest_formula_events([{
            "code": "PLACE_OK",
            "formulaId": "庄2|闲2",
            "eventId": "dw1",
            "betTransactionId": "tx-dw1",
            "simulated": False,
        }])
        self.assertEqual(dup["inserted"], 0)
        self.assertEqual(dup["duplicate"], 1)
        self.assertTrue(dup["ok"])


if __name__ == "__main__":
    unittest.main()
