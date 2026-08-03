#!/usr/bin/env python3
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from road_archive import (
    RoadArchive,
    parse_pattern,
    replay_formula_on_seq,
    seq_to_columns,
)


class RoadArchiveTest(unittest.TestCase):
    def test_parse_and_columns(self):
        p = parse_pattern("庄庄闲闲")
        self.assertTrue(p["ok"])
        self.assertEqual(p["patternHash"], "庄2|闲2")
        cols = seq_to_columns("BBPPBTB")
        self.assertEqual([(c["side"], c["length"]) for c in cols], [("庄", 2), ("闲", 2), ("庄", 2)])

    def test_replay_follow(self):
        # After 庄2|闲2 match at BBPP, next B → follow tip闲 → LOSE
        p = parse_pattern("庄庄闲闲")
        r = replay_formula_on_seq("BBPPB", p["columns"], bet_mode="follow")
        self.assertEqual(r["matches"], 1)
        self.assertEqual(r["lose"], 1)
        self.assertEqual(r["win"], 0)

    def test_tie_excluded(self):
        p = parse_pattern("庄庄")
        r = replay_formula_on_seq("BBT", p["columns"], bet_mode="follow")
        self.assertEqual(r["matches"], 1)
        self.assertEqual(r["tie"], 1)
        self.assertEqual(r["win"] + r["lose"], 0)

    def test_tie_then_settle_like_live(self):
        p = parse_pattern("庄庄")
        # Match at BB, then T then B(庄) → follow tip 庄 → WIN, with 1 tie skipped.
        r = replay_formula_on_seq("BBTB", p["columns"], bet_mode="follow")
        self.assertEqual(r["matches"], 1)
        self.assertEqual(r["tie"], 1)
        self.assertEqual(r["win"], 1)
        self.assertEqual(r["lose"], 0)

        # Two ties then banker settle.
        r2 = replay_formula_on_seq("BBTTB", p["columns"], bet_mode="follow")
        self.assertEqual(r2["matches"], 1)
        self.assertEqual(r2["tie"], 2)
        self.assertEqual(r2["win"], 1)

        # Only ties after match — no win/lose guess.
        r3 = replay_formula_on_seq("BBTT", p["columns"], bet_mode="follow")
        self.assertEqual(r3["matches"], 1)
        self.assertEqual(r3["tie"], 2)
        self.assertEqual(r3["win"] + r3["lose"], 0)

    def test_ingest_and_stats(self):
        with tempfile.TemporaryDirectory() as td:
            arch = RoadArchive(Path(td))
            arch.ingest([{
                "day": "2026-07-23",
                "tid": 36,
                "title": "经典百家乐1",
                "g": 2001,
                "cat": "c",
                "boot": "B1",
                "mode": "full",
                "seq": "BBPPB",
                "account": "ab***cd",
            }], account="ab***cd", client_id="c1")
            arch.ingest([{
                "day": "2026-07-23",
                "tid": 36,
                "boot": "B1",
                "mode": "delta",
                "from": 5,
                "add": "P",
            }])
            stats = arch.formula_stats("庄庄闲闲", day_from="2026-07-23", day_to="2026-07-23", bet_mode="follow")
            self.assertTrue(stats["ok"])
            self.assertGreaterEqual(stats["bootsScanned"], 1)
            self.assertEqual(stats["matches"], 1)

    def test_delta_overlap_does_not_truncate(self):
        with tempfile.TemporaryDirectory() as td:
            arch = RoadArchive(Path(td))
            arch.ingest([{
                "day": "2026-07-23",
                "tid": 7,
                "boot": "B1",
                "mode": "full",
                "seq": "BBPPB",
            }], account="a", client_id="c1")
            # Client thinks from=3 but server already has 5 — overlap must append only unseen suffix.
            ok = arch.ingest([{
                "day": "2026-07-23",
                "tid": 7,
                "boot": "B1",
                "mode": "delta",
                "from": 3,
                "add": "PBP",
            }])
            self.assertEqual(ok["accepted"], 1)
            ov = arch.overview(limit_tables=10)
            self.assertTrue(ov["ok"])
            rows = [r for r in ov["recentTables"] if int(r.get("tid") or 0) == 7]
            self.assertTrue(rows)
            self.assertEqual(rows[0]["n"], 6)
            self.assertTrue(str(rows[0].get("preview") or "").endswith("P"))


if __name__ == "__main__":
    unittest.main()
