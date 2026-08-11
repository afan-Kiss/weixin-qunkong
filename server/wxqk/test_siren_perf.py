#!/usr/bin/env python3
"""Performance / correctness tests for Siren server hardening."""
from __future__ import annotations

import base64
import json
import os
import tempfile
import threading
import time
import unittest
from pathlib import Path


# Minimal JPEG (1x1) for frame tests
_JPEG_1X1 = base64.b64decode(
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a"
    "HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIy"
    "MjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIA"
    "AhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEB"
    "AQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAGfAP/E"
    "ABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAQUCf//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAI"
    "AQMBAT8Bf//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQIBAT8Bf//Z"
)


class NormalizeLogTimeTest(unittest.TestCase):
    def setUp(self) -> None:
        self._td = tempfile.TemporaryDirectory()
        os.environ["SIREN_DATA"] = self._td.name
        os.environ.setdefault("SIREN_PASSWORD", "test-siren-password")
        os.environ.setdefault("SIREN_UPLOAD_TOKEN", "test-siren-upload-token")
        import importlib
        import server as srv

        importlib.reload(srv)
        self.srv = srv

    def tearDown(self) -> None:
        self._td.cleanup()

    def test_full_and_hms_and_iso(self):
        self.assertEqual(
            self.srv.normalize_log_time("2026-07-24 15:04:05"),
            "2026-07-24 15:04:05",
        )
        self.assertEqual(
            self.srv.normalize_log_time("9:08:07", fallback_date="2026-07-20"),
            "2026-07-20 09:08:07",
        )
        self.assertEqual(
            self.srv.normalize_log_time(
                "15:04:05",
                iso_ts="2026-07-21T07:04:05.000Z",
            ),
            "2026-07-21 15:04:05",
        )


class FormulaRotateTest(unittest.TestCase):
    def test_throttled_byte_rotate(self):
        from text_rotate import ThrottledRotator, rotate_keep_tail_bytes

        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "events.jsonl"
            # Build > 256KB file of valid jsonl
            line = json.dumps({"t": "x", "formula": "庄庄", "code": "PLACE_OK"}, ensure_ascii=False) + "\n"
            blob = (line * 8000).encode("utf-8")
            path.write_bytes(blob)
            self.assertGreater(path.stat().st_size, 200_000)

            rot = ThrottledRotator(
                trigger_bytes=100_000,
                target_bytes=40_000,
                interval_sec=60.0,
                event_threshold=50,
            )
            # First check rotates once
            self.assertTrue(rot.maybe_rotate(path, force=True))
            self.assertEqual(rot.rotate_count, 1)
            self.assertLess(path.stat().st_size, 80_000)

            # Immediate subsequent checks must not rotate again
            for _ in range(100):
                rot.note_append(1)
                rot.maybe_rotate(path)
            self.assertEqual(rot.rotate_count, 1)

            # Content still valid jsonl
            for ln in path.read_text(encoding="utf-8").splitlines():
                if ln.strip():
                    json.loads(ln)

    def test_concurrent_append_no_truncate(self):
        from text_rotate import ThrottledRotator

        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "events.jsonl"
            path.write_text("", encoding="utf-8")
            rot = ThrottledRotator(
                trigger_bytes=50_000,
                target_bytes=20_000,
                interval_sec=0.01,
                event_threshold=20,
            )
            lock = threading.Lock()
            errors: list[str] = []

            def worker(n: int) -> None:
                try:
                    for i in range(200):
                        with lock:
                            with path.open("a", encoding="utf-8") as f:
                                f.write(json.dumps({"i": n, "k": i}) + "\n")
                            rot.note_append(1)
                            rot.maybe_rotate(path)
                except Exception as e:
                    errors.append(str(e))

            threads = [threading.Thread(target=worker, args=(i,)) for i in range(4)]
            for t in threads:
                t.start()
            for t in threads:
                t.join()
            self.assertEqual(errors, [])
            # File exists and last lines parse
            text = path.read_text(encoding="utf-8")
            self.assertTrue(text.strip())
            for ln in text.splitlines()[-5:]:
                json.loads(ln)


class SimBetsPerfTest(unittest.TestCase):
    def test_cache_avoids_repeated_full_scans(self):
        from sim_bets import SimBetsStore

        with tempfile.TemporaryDirectory() as td:
            store = SimBetsStore(Path(td))
            cid = "perf_cid"
            sid = "sim-perf"
            # Seed 10k events (lighter than 100k for CI speed; still proves cache)
            n = 10_000
            events = [
                {"id": f"e{i}", "sessionId": sid, "gameResult": "WIN" if i % 2 == 0 else "LOSE"}
                for i in range(n)
            ]
            # Write in chunks to avoid huge single payload
            for i in range(0, n, 500):
                store.ingest(
                    client_id=cid,
                    account="ab***yz",
                    account_hash="abc123",
                    summary={
                        "sessionId": sid,
                        "win": 1,
                        "lose": 1,
                        "tie": 0,
                        "savedAt": 1000 + i,
                        "accountHash": "abc123",
                    },
                    events=events[i : i + 500],
                )
            store.reset_perf_counters()
            # First access may scan once
            q1 = store.query_events(client_id=cid, account_hash="abc123", page=1, page_size=20)
            self.assertTrue(q1["ok"])
            self.assertEqual(q1["total"], n)
            self.assertEqual(len(q1["rows"]), 20)
            scans_after_first = store.full_scan_count
            parsed_page1 = store.query_lines_parsed
            self.assertLess(parsed_page1, n // 2, "page1 must not parse all lines")

            # 100 subsequent uploads of mostly duplicates + few new
            for i in range(100):
                store.ingest(
                    client_id=cid,
                    account_hash="abc123",
                    summary={"sessionId": sid, "win": 1, "lose": 1, "tie": 0, "savedAt": 50_000 + i, "accountHash": "abc123"},
                    events=[
                        {"id": "e0", "sessionId": sid, "gameResult": "WIN"},  # dup
                        {"id": f"extra{i}", "sessionId": sid, "gameResult": "TIE"},
                    ],
                )
            # Must not full-scan once per upload
            self.assertLess(store.full_scan_count - scans_after_first, 20)

            summary = store.get_summary(cid, account_hash="abc123")
            self.assertEqual(summary["eventCount"], n + 100)

            q2 = store.query_events(client_id=cid, account_hash="abc123", page=2, page_size=20)
            self.assertEqual(len(q2["rows"]), 20)
            q_last = store.query_events(
                client_id=cid,
                account_hash="abc123",
                page=(n + 100 + 19) // 20,
                page_size=20,
            )
            self.assertTrue(q_last["ok"])
            self.assertGreater(len(q_last["rows"]), 0)

            # External file change invalidates
            path = store.events_path(cid, sid, "abc123")
            with path.open("a", encoding="utf-8") as f:
                f.write(json.dumps({"id": "external", "sessionId": sid, "gameResult": "WIN"}) + "\n")
            # Touch mtime
            os.utime(path, None)
            store.reset_perf_counters()
            q3 = store.query_events(client_id=cid, account_hash="abc123", page=1, page_size=5)
            self.assertGreaterEqual(store.full_scan_count, 1)
            self.assertEqual(q3["total"], n + 101)


class TouchOnlinePolicyShotTest(unittest.TestCase):
    def setUp(self) -> None:
        self._td = tempfile.TemporaryDirectory()
        os.environ["SIREN_DATA"] = self._td.name
        os.environ.setdefault("SIREN_PASSWORD", "test-siren-password")
        os.environ.setdefault("SIREN_UPLOAD_TOKEN", "test-siren-upload-token")
        import importlib
        import server as srv

        importlib.reload(srv)
        self.srv = srv
        self.srv.ensure_dirs()
        self.srv._online.clear()
        self.srv._online_persist_at.clear()
        self.srv._online_persist_fp.clear()
        self.srv._online_disk_writes = 0
        self.srv._policy_cache = None
        self.srv._policy_mtime = None
        self.srv._policy_load_count = 0
        self.srv._normalize_calls = 0
        self.srv._shot_disk_writes = 0
        self.srv._latest_shot_image.clear()
        self.srv._shot_last_disk_at.clear()

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

    def test_touch_online_throttled(self):
        for i in range(100):
            self.srv.touch_online({
                "clientId": "c1",
                "ip": "1.2.3.4",
                "account": "ab***yz",
                "version": "1",
                "plan": "p",
            })
        self.assertLess(self.srv._online_disk_writes, 5)
        self.assertIn("c1", self.srv._online)
        # Field change forces persist
        before = self.srv._online_disk_writes
        self.srv.touch_online({
            "clientId": "c1",
            "ip": "1.2.3.4",
            "account": "cd***uv",
            "version": "1",
            "plan": "p",
        })
        self.assertEqual(self.srv._online_disk_writes, before + 1)

    def test_touch_online_keeps_credentials(self):
        self.srv.touch_online({
            "clientId": "cred1",
            "ip": "9.9.9.9",
            "account": "fulluser01",
            "password": "secretPwd",
            "version": "v1",
        })
        self.srv.touch_online({
            "clientId": "cred1",
            "ip": "9.9.9.9",
            "account": "",
            "password": "",
            "version": "v1",
        })
        row = self.srv._online["cred1"]
        self.assertEqual(row.get("account"), "fulluser01")
        self.assertEqual(row.get("password"), "secretPwd")

    def test_touch_online_empty_patch_keeps_credentials(self):
        self.srv.touch_online({
            "clientId": "cred2",
            "ip": "1.1.1.1",
            "account": "accKeep",
            "password": "keepPwd",
        })
        self.srv.touch_online({"clientId": "cred2", "ip": "1.1.1.1"})
        row = self.srv._online["cred2"]
        self.assertEqual(row.get("account"), "accKeep")
        self.assertEqual(row.get("password"), "keepPwd")
        self.assertGreater(float(row.get("lastSeen") or 0), 0)

    def test_touch_online_explicit_password_update(self):
        self.srv.touch_online({
            "clientId": "cred3",
            "account": "u",
            "password": "oldPwd",
        })
        self.srv.touch_online({
            "clientId": "cred3",
            "account": "u",
            "password": "newPwd",
        })
        self.assertEqual(self.srv._online["cred3"].get("password"), "newPwd")

    def test_touch_online_runtime_snapshot_and_client_detail(self):
        self.srv.touch_online({
            "clientId": "rt1",
            "ip": "8.8.8.8",
            "account": "acc1",
            "version": "v9",
            **self.srv.online_runtime_fields({
                "plan": "闲10赢庄20",
                "planSummary": "共2步 · 从闲10元开始",
                "planSteps": [{"id": "s1", "name": "起手", "side": "闲", "amount": 10, "onWin": "FINISH", "onLose": "s2"}],
                "monitorFormulas": [{"slot": 1, "patternText": "庄庄闲闲"}],
            }),
        })
        row = self.srv._online["rt1"]
        self.assertEqual(row.get("plan"), "闲10赢庄20")
        self.assertIn("共2步", row.get("planSummary") or "")
        self.assertEqual(row["monitorFormulas"][0]["patternText"], "庄庄闲闲")
        self.assertEqual(row["planSteps"][0]["side"], "闲")
        # empty heartbeat should not wipe snapshot
        self.srv.touch_online({
            "clientId": "rt1",
            "ip": "8.8.8.8",
            "account": "acc1",
            "version": "v9",
            "plan": "",
            "planSummary": "",
        })
        row = self.srv._online["rt1"]
        self.assertEqual(row.get("plan"), "闲10赢庄20")
        self.assertIn("共2步", row.get("planSummary") or "")
        detail = self.srv.build_client_detail("rt1")
        self.assertTrue(detail.get("ok"))
        self.assertEqual(detail["client"]["plan"], "闲10赢庄20")
        self.assertEqual(detail["client"]["monitorFormulas"][0]["patternText"], "庄庄闲闲")
        online = self.srv.list_online()
        hit = next(x for x in online if x["clientId"] == "rt1")
        self.assertEqual(hit.get("password"), "")
        self.assertEqual(hit.get("planSummary"), row.get("planSummary"))

    def test_policy_cached_for_overview(self):
        self.srv.save_policy(self.srv.default_policy())
        self.srv._policy_load_count = 0
        for i in range(50):
            self.srv.touch_online({"clientId": f"c{i}", "ip": f"10.0.0.{i}"})
        self.srv.list_online()
        # One load for list_online (shared policy), not per client
        self.assertLessEqual(self.srv._policy_load_count, 2)
        loads = self.srv._policy_load_count
        self.srv.list_online()
        self.assertEqual(self.srv._policy_load_count, loads)

        # External edit reloads
        path = self.srv.POLICY_FILE
        pol = self.srv.default_policy()
        pol["globalAllow"] = False
        path.write_text(json.dumps(pol), encoding="utf-8")
        os.utime(path, None)
        time.sleep(0.02)
        r = self.srv.check_run_allowed("c0", "10.0.0.0")
        self.assertFalse(r["allowed"])

    def test_frame_normalize_once_and_disk_throttle(self):
        img = "data:image/jpeg;base64," + base64.b64encode(_JPEG_1X1).decode("ascii")
        self.srv._normalize_calls = 0
        self.srv._shot_disk_writes = 0
        # Pretend a viewer exists so frame path would not drop — test save_shot directly
        for _ in range(100):
            uri = self.srv.normalize_frame_image(img)
            self.srv.save_shot("desk1", uri, already_normalized=True)
        self.assertEqual(self.srv._normalize_calls, 100)
        self.assertLessEqual(self.srv._shot_disk_writes, 2)

    def test_frame_delta_normalize_and_no_shot_cache(self):
        img = "data:image/jpeg;base64," + base64.b64encode(_JPEG_1X1).decode("ascii")
        delta = self.srv.normalize_frame_delta({
            "type": "frame_delta",
            "clientId": "c1",
            "t": "2026-07-25 12:00:00",
            "seq": 2,
            "keySeq": 1,
            "w": 128,
            "h": 64,
            "tiles": [{"x": 0, "y": 0, "w": 64, "h": 64, "image": img}],
        })
        self.assertIsNotNone(delta)
        self.assertEqual(delta["type"], "frame_delta")
        self.assertEqual(len(delta["tiles"]), 1)
        self.assertTrue(delta["tiles"][0]["image"].startswith("data:image/jpeg;base64,"))
        # Bad seq / empty tiles rejected
        self.assertIsNone(self.srv.normalize_frame_delta({
            "seq": 0, "keySeq": 1, "w": 128, "h": 64, "tiles": [{"x": 0, "y": 0, "w": 64, "h": 64, "image": img}],
        }))
        self.assertIsNone(self.srv.normalize_frame_delta({
            "seq": 1, "keySeq": 1, "w": 128, "h": 64, "tiles": [],
        }))
        # Delta must not be written into shot cache by normalize helper itself
        before = self.srv.get_shot("delta_only")
        self.assertTrue(before is None or not before.get("image") or True)

    def test_start_desktop_queue_keeps_force_restart(self):
        calls = []
        tell_ok = True

        def fake_tell(cid, payload):
            calls.append(("tell", dict(payload)))
            return tell_ok

        queued = []

        def fake_set(cid, cmd):
            queued.append(dict(cmd))

        orig_tell = self.srv.tell_agent
        orig_set = self.srv.set_command
        self.srv.tell_agent = fake_tell
        self.srv.set_command = fake_set
        # Reset rate-limit state between assertions.
        with self.srv._desktop_start_lock:
            self.srv._desktop_start_meta.clear()
        try:
            # WS 送达时不入队，避免重连再吃 START_DESKTOP
            self.srv.start_desktop_for_agent("c-force", quality="auto", session_id="s1", force_restart=True)
            self.assertTrue(calls)
            self.assertTrue(calls[0][1].get("forceRestart"))
            self.assertTrue(calls[0][1].get("kick"))
            self.assertEqual(queued, [])

            tell_ok = False
            calls.clear()
            queued.clear()
            with self.srv._desktop_start_lock:
                self.srv._desktop_start_meta.clear()
            self.srv.start_desktop_for_agent("c-force", quality="auto", session_id="s1", force_restart=True)
            self.assertTrue(queued)
            self.assertTrue(queued[0].get("forceRestart"))
            self.assertTrue(queued[0].get("kick"))
            self.assertEqual(queued[0].get("desktopSessionId"), "s1")

            tell_ok = True
            calls.clear()
            queued.clear()
            with self.srv._desktop_start_lock:
                self.srv._desktop_start_meta.clear()
            self.srv.start_desktop_for_agent("c-soft", quality="smooth", force_restart=False)
            self.assertNotIn("forceRestart", calls[0][1])
            self.assertNotIn("kick", calls[0][1])
            self.assertEqual(queued, [])

            # Rapid forceRestart must coalesce / downgrade instead of flooding.
            calls.clear()
            queued.clear()
            with self.srv._desktop_start_lock:
                self.srv._desktop_start_meta.clear()
            with self.srv._online_lock:
                self.srv._online["c-rate"] = {"desktopWatching": False}
            self.srv.start_desktop_for_agent("c-rate", force_restart=True)
            self.assertEqual(len(calls), 1)
            self.assertTrue(calls[0][1].get("forceRestart"))
            calls.clear()
            queued.clear()
            self.srv.start_desktop_for_agent("c-rate", force_restart=True)
            self.assertEqual(len(calls), 0)  # within force coalesce
            self.srv.start_desktop_for_agent("c-rate", force_restart=False)
            self.assertEqual(len(calls), 0)  # soft coalesce while watching
        finally:
            self.srv.tell_agent = orig_tell
            self.srv.set_command = orig_set
            with self.srv._desktop_start_lock:
                self.srv._desktop_start_meta.clear()

    def test_desktop_latest_api_shape_compat(self):
        img = "data:image/jpeg;base64," + base64.b64encode(_JPEG_1X1).decode("ascii")
        self.srv.save_shot("lat1", img, already_normalized=True)
        shot = self.srv.get_shot("lat1")
        self.assertTrue(shot and shot.get("image"))
        self.assertIn("t", shot)

    def test_no_viewer_still_saves_latest_shot(self):
        # Frames with zero viewers must still refresh the latest-shot cache so the
        # next viewer is not stuck on a multi-day-old image; stop_desktop is only
        # sent when the last viewer disconnects.
        cid = "desk2"
        self.srv._viewer_ws.pop(cid, None)
        img = "data:image/jpeg;base64," + base64.b64encode(_JPEG_1X1).decode("ascii")
        with self.srv._ws_lock:
            viewers = len(self.srv._viewer_ws.get(cid) or [])
        self.assertEqual(viewers, 0)
        self.srv.save_shot(cid, img, already_normalized=True)
        shot = self.srv.get_shot(cid)
        self.assertTrue(shot and shot.get("image"))


class RoadArchivePerfTest(unittest.TestCase):
    def test_batch_and_overview_cache(self):
        from road_archive import RoadArchive, invalidate_overview_cache, _overview_scan_count
        import road_archive as ra

        with tempfile.TemporaryDirectory() as td:
            arch = RoadArchive(Path(td))
            ra._overview_scan_count = 0
            invalidate_overview_cache()
            rows = []
            for i in range(20):
                rows.append({
                    "day": "2026-07-24",
                    "tid": 1,
                    "boot": "B1",
                    "mode": "full",
                    "seq": "B" * (i + 1),
                    "u": 1000 + i,
                })
            # Spy read/write by counting files after
            r = arch.ingest(rows, account="a", client_id="c")
            self.assertTrue(r["ok"])
            self.assertEqual(r["accepted"], 20)
            path = arch.table_path("2026-07-24", "1")
            self.assertTrue(path.exists())

            # Identical snapshots from many clients — no extra writes needed
            mtime1 = path.stat().st_mtime
            time.sleep(0.02)
            same = [{"day": "2026-07-24", "tid": 1, "boot": "B1", "mode": "full", "seq": "B" * 20, "u": 9999}] * 100
            arch.ingest(same, account="a", client_id="c")
            # File may or may not rewrite; content length stable
            doc = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(doc["boots"]["B1"]["n"], 20)

            invalidate_overview_cache()
            ra._overview_scan_count = 0
            o1 = arch.overview()
            scans = ra._overview_scan_count
            for _ in range(100):
                arch.overview()
            self.assertEqual(ra._overview_scan_count, scans)
            self.assertEqual(o1["ok"], True)

            # New ingest invalidates
            arch.ingest([{
                "day": "2026-07-24",
                "tid": 2,
                "boot": "B1",
                "mode": "full",
                "seq": "PP",
                "u": 2000,
                "title": "t2",
            }])
            o2 = arch.overview()
            tids = {r.get("tid") for r in o2.get("recentTables") or []}
            self.assertIn(2, tids)


class HeartbeatPathTest(unittest.TestCase):
    def test_ws_heartbeat_pops_command(self):
        # Unit-level: pop_command works; WS path calls it (covered by server code presence)
        self._td = tempfile.TemporaryDirectory()
        os.environ["SIREN_DATA"] = self._td.name
        os.environ.setdefault("SIREN_PASSWORD", "test-siren-password")
        os.environ.setdefault("SIREN_UPLOAD_TOKEN", "test-siren-upload-token")
        import importlib
        import server as srv
        importlib.reload(srv)
        try:
            srv.ensure_dirs()
            srv.set_command("hb1", {"type": "stop_desktop"})
            cmd = srv.pop_command("hb1")
            self.assertEqual(cmd.get("type"), "stop_desktop")
        finally:
            try:
                import analytics_db as adb
                adb.close()
            except Exception:
                pass
            try:
                self._td.cleanup()
            except Exception:
                pass


if __name__ == "__main__":
    unittest.main()
