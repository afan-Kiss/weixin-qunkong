# -*- coding: utf-8 -*-
"""Command delivery lease, supersede, and concurrent DB safety."""
from __future__ import annotations

import importlib
import os
import random
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

os.environ.setdefault("SIREN_PASSWORD", "test-siren-password")
os.environ.setdefault("FACAI888_SECURITY_MODE", "test")


class CommandLeaseTest(unittest.TestCase):
    def setUp(self) -> None:
        self._td = tempfile.TemporaryDirectory()
        self.data = Path(self._td.name)
        os.environ["SIREN_DATA"] = str(self.data)

        import security_db
        import command_queue
        import security_audit

        security_db.close()
        importlib.reload(security_db)
        importlib.reload(command_queue)
        importlib.reload(security_audit)
        security_db.configure(self.data)
        self.sdb = security_db
        self.cq = command_queue
        self.sa = security_audit

    def tearDown(self) -> None:
        try:
            self.sdb.close()
        except Exception:
            pass
        try:
            self._td.cleanup()
        except Exception:
            pass

    def test_stop_supersedes_pending_start(self) -> None:
        cid = "device_stop_start"
        start = self.cq.enqueue(cid, "START_DESKTOP", {"continuous": True}, policy_epoch=1)
        self.cq.enqueue(cid, "STOP_DESKTOP", {}, policy_epoch=1)
        conn = self.sdb.get_conn()
        row = conn.execute(
            "SELECT status, failure_reason FROM device_commands WHERE command_id=?",
            (start["commandId"],),
        ).fetchone()
        self.assertEqual(row["status"], "EXPIRED")
        self.assertEqual(row["failure_reason"], "superseded_by_stop_desktop")
        popped = self.cq.pop_next(cid)
        self.assertIsNotNone(popped)
        self.assertEqual(popped.get("commandType"), "STOP_DESKTOP")

    def test_delivered_redelivered_after_lease(self) -> None:
        cid = "device_redeliver_delivered"
        enq = self.cq.enqueue(cid, "REFRESH_POLICY", {}, policy_epoch=1)
        cmd_id = enq["commandId"]
        first = self.cq.pop_next(cid)
        self.assertEqual(first["commandId"], cmd_id)
        conn = self.sdb.get_conn()
        conn.execute(
            "UPDATE device_commands SET last_delivery_at=? WHERE command_id=?",
            (self.sdb.now_ts() - 31.0, cmd_id),
        )
        conn.commit()
        second = self.cq.pop_next(cid)
        self.assertIsNotNone(second)
        self.assertEqual(second["commandId"], cmd_id)
        count = conn.execute(
            "SELECT delivery_count FROM device_commands WHERE command_id=?",
            (cmd_id,),
        ).fetchone()[0]
        self.assertGreaterEqual(int(count), 2)

    def test_received_redelivered_after_lease(self) -> None:
        cid = "device_redeliver_received"
        enq = self.cq.enqueue(cid, "CHECK_CLIENT_UPDATE", {}, policy_epoch=1)
        cmd_id = enq["commandId"]
        self.cq.pop_next(cid)
        self.cq.ack(cid, cmd_id, status="RECEIVED")
        conn = self.sdb.get_conn()
        conn.execute(
            "UPDATE device_commands SET last_delivery_at=? WHERE command_id=?",
            (self.sdb.now_ts() - 31.0, cmd_id),
        )
        conn.commit()
        again = self.cq.pop_next(cid)
        self.assertIsNotNone(again)
        self.assertEqual(again["commandId"], cmd_id)

    def test_concurrent_enqueue_pop_ack_audit(self) -> None:
        errors: list[BaseException] = []
        barrier = threading.Barrier(20)

        def worker(i: int) -> None:
            try:
                barrier.wait(timeout=30)
                cid = f"dev_{i % 4}"
                action = i % 5
                if action == 0:
                    self.cq.enqueue(cid, "SHOW_ANNOUNCEMENT", {"text": f"t{i}"}, policy_epoch=1)
                elif action == 1:
                    self.cq.enqueue(cid, "START_DESKTOP", {}, policy_epoch=1)
                elif action == 2:
                    self.cq.enqueue(cid, "STOP_DESKTOP", {}, policy_epoch=1)
                elif action == 3:
                    cmd = self.cq.pop_next(cid)
                    if cmd and random.random() < 0.7:
                        self.cq.ack(cid, cmd["commandId"], status="RECEIVED")
                else:
                    self.sa.emit(
                        "test.concurrent",
                        device_id=cid,
                        reason_code=f"w{i}",
                        detail={"n": i},
                    )
            except BaseException as e:  # noqa: BLE001
                errors.append(e)

        threads = [threading.Thread(target=worker, args=(i,)) for i in range(20)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=60)
        self.assertFalse(errors, errors)

    def test_mark_delivery_send_failed_allows_quick_retry(self) -> None:
        cid = "device_send_fail"
        enq = self.cq.enqueue(cid, "REFRESH_POLICY", {}, policy_epoch=1)
        cmd_id = enq["commandId"]
        self.cq.pop_next(cid)
        self.cq.mark_delivery_send_failed(cid, cmd_id)
        again = self.cq.pop_next(cid)
        self.assertIsNotNone(again)
        self.assertEqual(again["commandId"], cmd_id)

    def test_prune_terminal_commands(self) -> None:
        cid = "device_prune"
        enq = self.cq.enqueue(cid, "REFRESH_POLICY", {}, policy_epoch=1)
        cmd = self.cq.pop_next(cid)
        self.cq.ack(cid, cmd["commandId"], status="APPLIED")
        conn = self.sdb.get_conn()
        conn.execute(
            "UPDATE device_commands SET applied_at=? WHERE command_id=?",
            (self.sdb.now_ts() - 40 * 86400, enq["commandId"]),
        )
        conn.commit()
        out = self.cq.prune_terminal_commands(retention_days=30, max_rows=100_000)
        self.assertGreaterEqual(int(out.get("deleted") or 0), 1)


if __name__ == "__main__":
    unittest.main()
