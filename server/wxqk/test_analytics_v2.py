#!/usr/bin/env python3
# -*- coding: utf-8 -*-
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import analytics_db as adb
from analytics_stats import benjamini_hochberg, jeffreys_mean, max_drawdown, wilson_interval
from big_road_engine import generate_big_road_from_chronological_seq, match_latest_columns, parse_pattern_columns
from formula_events import ingest_formula_events, make_event_id
from road_archive import RoadArchive
from road_quality import compute_seq_hash, grade_quality
from strict_replay import strict_road_formula_winrate


class AnalyticsCoreTest(unittest.TestCase):
    def setUp(self):
        self._td = tempfile.TemporaryDirectory()
        adb.close()
        adb.configure(Path(self._td.name))
        adb.get_conn()

    def tearDown(self):
        adb.close()
        self._td.cleanup()

    def test_wilson_and_jeffreys(self):
        w = wilson_interval(60, 40)
        self.assertAlmostEqual(w["rawWinRate"], 0.6)
        self.assertLess(w["wilsonLower"], 0.6)
        self.assertGreater(w["wilsonUpper"], 0.6)
        j = jeffreys_mean(60, 40)
        self.assertIsNotNone(j["bayesMean"])
        self.assertIsNone(j["bayesLower95"])  # no SciPy

    def test_fdr(self):
        rows = benjamini_hochberg([0.001, 0.01, 0.03, 0.2])
        self.assertTrue(rows[0]["fdrSignificant"])
        self.assertFalse(rows[3]["fdrSignificant"])

    def test_drawdown(self):
        self.assertEqual(max_drawdown([1, -2, 0.5, -1]), 2.5)

    def test_event_id_stable_and_dedupe(self):
        ev = {
            "schemaVersion": 2,
            "clientId": "c1",
            "accountHash": "ah",
            "betTransactionId": "tx1",
            "code": "PLACE_OK",
            "simulated": False,
            "formulaId": "庄2|闲2",
            "slot": 1,
            "patternText": "庄庄闲闲",
        }
        eid = make_event_id(ev)
        r1 = ingest_formula_events([{**ev, "eventId": eid}])
        r2 = ingest_formula_events([{**ev, "eventId": eid}])
        self.assertEqual(r1["accepted"], 1)
        self.assertEqual(r2["accepted"], 0)

    def test_big_road_dragon_and_match(self):
        # 闲6 + 4 tails ≈ length 10 logical
        seq = "P" * 10
        g = generate_big_road_from_chronological_seq(seq)
        self.assertTrue(g["ok"])
        self.assertEqual(g["columns"][-1]["length"], 10)
        parsed = parse_pattern_columns("闲闲闲闲闲闲闲闲闲闲")
        m = match_latest_columns(g, parsed["columns"])
        self.assertTrue(m["matched"])

    def test_quality_grades(self):
        a, _ = grade_quality(
            boot_no="B1", continuity_ok=True, geometry_verified=True,
            classification_verified=True, consensus_client_count=2, source_client_count=2,
        )
        self.assertEqual(a, "A")
        b, _ = grade_quality(
            boot_no="B1", continuity_ok=True, geometry_verified=True,
            classification_verified=True, consensus_client_count=1, source_client_count=1,
        )
        self.assertEqual(b, "B")
        c, reasons = grade_quality(
            boot_no="_", continuity_ok=True, geometry_verified=True,
            classification_verified=True, consensus_client_count=2, source_client_count=2,
        )
        self.assertEqual(c, "C")
        self.assertIn("UNKNOWN_BOOT", reasons)
        d, _ = grade_quality(
            boot_no="B1", continuity_ok=True, geometry_verified=True,
            classification_verified=True, consensus_client_count=1, source_client_count=2,
            conflict=True,
        )
        self.assertEqual(d, "D")

    def test_seq_hash_stable(self):
        h1 = compute_seq_hash("2026-07-24", 36, "B1", "BBPP", "")
        h2 = compute_seq_hash("2026-07-24", 36, "B1", "BBPP", "")
        self.assertEqual(h1, h2)
        self.assertEqual(len(h1), 64)

    def test_strict_replay_and_road_ingest(self):
        root = Path(self._td.name) / "roads"
        arch = RoadArchive(root)
        arch.ingest([{
            "day": "2026-07-24",
            "tid": 36,
            "boot": "B1",
            "mode": "full",
            "seq": "BBPPB",
            "seqHash": compute_seq_hash("2026-07-24", 36, "B1", "BBPPB", ""),
            "schemaVersion": 2,
            "geometryVerified": True,
            "classificationVerified": True,
            "cat": "c",
        }], account="a", client_id="c1")
        # second client same hash → A potential
        arch.ingest([{
            "day": "2026-07-24",
            "tid": 36,
            "boot": "B1",
            "mode": "full",
            "seq": "BBPPB",
            "seqHash": compute_seq_hash("2026-07-24", 36, "B1", "BBPPB", ""),
            "schemaVersion": 2,
            "geometryVerified": True,
            "classificationVerified": True,
            "cat": "c",
        }], account="b", client_id="c2")
        boots = arch.collect_boots(day_from="2026-07-24", day_to="2026-07-24", quality_filter="ALL")
        self.assertTrue(boots)
        # Force quality A/B for replay by patching
        for b in boots:
            b["qualityLevel"] = "B"
        r = strict_road_formula_winrate(boots, pattern="庄庄闲闲", bet_mode="follow", include_heavy=False)
        self.assertTrue(r["ok"])
        self.assertGreaterEqual(r["matches"], 1)

    def test_illegal_chars_rejected(self):
        root = Path(self._td.name) / "roads2"
        arch = RoadArchive(root)
        r = arch.ingest([{
            "day": "2026-07-24", "tid": 1, "boot": "B1", "mode": "full", "seq": "BBX",
            "schemaVersion": 2, "geometryVerified": True, "classificationVerified": True,
        }], client_id="c1")
        self.assertEqual(r["accepted"], 0)


if __name__ == "__main__":
    unittest.main()
