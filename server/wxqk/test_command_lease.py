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

    def test_prune_terminal_max_rows_subquery_no_placeholder_blast(self) -> None:
        """Cap terminal rows with subquery LIMIT; active rows must survive."""
        import inspect

        src = inspect.getsource(self.cq.prune_terminal_commands)
        self.assertNotIn('placeholders = ",".join', src)
        self.assertIn("LIMIT ?", src)

        conn = self.sdb.get_conn()
        now = self.sdb.now_ts()
        # bulk insert terminal rows
        rows = []
        for i in range(1500):
            rows.append(
                (
                    f"cmd_term_{i}",
                    "device_bulk",
                    "REFRESH_POLICY",
                    1,
                    "{}",
                    now - 10,
                    now + 3600,
                    "APPLIED",
                    1,
                    "",
                    now - 10,
                )
            )
        conn.executemany(
            """
            INSERT INTO device_commands(
              command_id, device_id, command_type, policy_epoch,
              payload_json, issued_at, expires_at, status, delivery_count,
              server_signature, applied_at
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
            """,
            rows,
        )
        # active rows that must not be pruned by max_rows
        for i, st in enumerate(("PENDING", "DELIVERED", "RECEIVED")):
            conn.execute(
                """
                INSERT INTO device_commands(
                  command_id, device_id, command_type, policy_epoch,
                  payload_json, issued_at, expires_at, status, delivery_count,
                  server_signature
                ) VALUES (?,?,?,?,?,?,?,?,?,?)
                """,
                (
                    f"cmd_active_{i}",
                    "device_bulk",
                    "START_DESKTOP",
                    1,
                    "{}",
                    now,
                    now + 3600,
                    st,
                    0,
                    "",
                ),
            )
        conn.commit()
        out = self.cq.prune_terminal_commands(retention_days=3650, max_rows=1000)
        self.assertGreaterEqual(int(out.get("deleted") or 0), 500)
        terminal = conn.execute(
            "SELECT COUNT(*) FROM device_commands WHERE status IN ('APPLIED','FAILED','EXPIRED')"
        ).fetchone()[0]
        self.assertLessEqual(int(terminal), 1000)
        active = conn.execute(
            "SELECT COUNT(*) FROM device_commands WHERE status IN ('PENDING','DELIVERED','RECEIVED')"
        ).fetchone()[0]
        self.assertEqual(int(active), 3)

    def test_peek_pending_includes_received(self) -> None:
        cid = "device_peek_received"
        enq = self.cq.enqueue(cid, "CHECK_CLIENT_UPDATE", {}, policy_epoch=1)
        cmd_id = enq["commandId"]
        self.cq.pop_next(cid)
        self.cq.ack(cid, cmd_id, status="RECEIVED")
        rows = self.cq.peek_pending(cid, limit=20)
        ids = [r.get("commandId") for r in rows]
        self.assertIn(cmd_id, ids)

    def test_prune_security_audit_max_rows_subquery(self) -> None:
        import inspect

        src = inspect.getsource(self.sa.prune_security_audit)
        self.assertNotIn('placeholders = ",".join', src)
        self.assertIn("LIMIT ?", src)
        conn = self.sdb.get_conn()
        now = self.sdb.now_ts()
        for i in range(200):
            self.sa.emit("test.prune", device_id="d1", reason_code=f"r{i}", detail={"i": i})
        # force older timestamps for half
        conn.execute(
            "UPDATE security_audit SET timestamp=? WHERE rowid <= 120",
            (now - 10,),
        )
        conn.commit()
        out = self.sa.prune_security_audit(retention_days=3650, max_rows=100)
        self.assertGreaterEqual(int(out.get("deleted") or 0), 50)
        count = conn.execute("SELECT COUNT(*) FROM security_audit").fetchone()[0]
        self.assertLessEqual(int(count), 100)


if __name__ == "__main__":
    unittest.main()
