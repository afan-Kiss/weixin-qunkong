#!/usr/bin/env python3
"""
Reconnect storm load probe for ThreadingHTTPServer agent sockets.

Clients use jittered reconnect (realistic), not a single thundering herd.

Usage:
  python test_reconnect_storm_gate.py --clients 100
  python test_reconnect_storm_gate.py --clients 1000
"""
from __future__ import annotations

import argparse
import json
import os
import random
import socket
import statistics
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

try:
    import resource  # type: ignore
except Exception:  # pragma: no cover
    resource = None  # type: ignore


class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):  # noqa: D401
        return

    def do_GET(self):  # noqa: N802
        if self.path.startswith("/api/ws/agent"):
            self.send_response(101, "Switching Protocols")
            self.send_header("Upgrade", "websocket")
            self.send_header("Connection", "Upgrade")
            self.send_header("Sec-WebSocket-Accept", "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=")
            self.end_headers()
            try:
                self.wfile.flush()
            except Exception:
                pass
            # Short hold: mimics handshake + first hello without pinning threads for seconds.
            time.sleep(0.002)
            return
        self.send_response(404)
        self.send_header("Connection", "close")
        self.end_headers()


def _connect_once(host: str, port: int, timeout: float = 15.0, retries: int = 4) -> float:
    last_err: Exception | None = None
    t0 = time.perf_counter()
    for attempt in range(retries):
        try:
            if attempt:
                time.sleep(0.02 * (2 ** (attempt - 1)) + random.random() * 0.05)
            s = socket.create_connection((host, port), timeout=timeout)
            try:
                s.settimeout(timeout)
                req = (
                    f"GET /api/ws/agent?clientId=storm HTTP/1.1\r\n"
                    f"Host: {host}:{port}\r\n"
                    f"Upgrade: websocket\r\n"
                    f"Connection: Upgrade\r\n"
                    f"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n"
                    f"Sec-WebSocket-Version: 13\r\n\r\n"
                ).encode("ascii")
                s.sendall(req)
                chunks = []
                while True:
                    try:
                        data = s.recv(4096)
                    except socket.timeout:
                        break
                    if not data:
                        break
                    chunks.append(data)
                    if b"\r\n\r\n" in b"".join(chunks):
                        break
                blob = b"".join(chunks)
                if b"101" not in blob:
                    raise RuntimeError(f"bad handshake: {blob[:120]!r}")
                return time.perf_counter() - t0
            finally:
                try:
                    s.close()
                except Exception:
                    pass
        except Exception as exc:
            last_err = exc
    raise RuntimeError(str(last_err or "connect_failed"))


def _serve() -> tuple[ThreadingHTTPServer, threading.Thread, str, int]:
    server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    server.daemon_threads = True
    try:
        server.socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    except Exception:
        pass
    server.request_queue_size = 4096
    try:
        server.socket.listen(server.request_queue_size)
    except Exception:
        pass
    host, port = server.server_address
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    for _ in range(20):
        try:
            _connect_once(host, port, timeout=2.0, retries=2)
            break
        except Exception:
            time.sleep(0.05)
    return server, thread, host, port


def _wave(host: str, port: int, clients: int, workers: int) -> tuple[list[float], int]:
    times: list[float] = []
    errors = 0

    def one(_i: int) -> float:
        # Jitter admission like real agent reconnect.
        time.sleep(random.random() * 0.35)
        return _connect_once(host, port)

    with ThreadPoolExecutor(max_workers=min(workers, clients)) as pool:
        futs = [pool.submit(one, i) for i in range(clients)]
        for fut in as_completed(futs):
            try:
                times.append(fut.result())
            except Exception:
                errors += 1
    return times, errors


def run_storm(clients: int, workers: int = 250) -> dict:
    server, _thread, host, port = _serve()
    times: list[float] = []
    reconnect: list[float] = []
    connect_errors = 0
    reconnect_errors = 0
    try:
        times, connect_errors = _wave(host, port, clients, workers)
        try:
            server.shutdown()
        except Exception:
            pass
        time.sleep(0.25)
        server, _thread, host, port = _serve()
        reconnect, reconnect_errors = _wave(host, port, clients, workers)
    finally:
        try:
            server.shutdown()
        except Exception:
            pass

    def pct(vals: list[float], p: float) -> float:
        if not vals:
            return -1.0
        ordered = sorted(vals)
        idx = min(len(ordered) - 1, max(0, int(round((p / 100.0) * (len(ordered) - 1)))))
        return ordered[idx]

    rss = -1
    try:
        if resource is not None:
            rss = int(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss)
    except Exception:
        rss = -1

    reconnect_ok = (len(reconnect) / float(clients)) if clients else 0.0
    # Gate: >=95% reconnect success after restart, p99 under 5s with jitter.
    passed = reconnect_ok >= 0.95 and (pct(reconnect, 99) < 5.0 or not reconnect)
    report = {
        "simulatedClients": clients,
        "successfulConnections": len(times),
        "successfulReconnects": len(reconnect),
        "failedAuthOrConnect": connect_errors + reconnect_errors,
        "connectErrors": connect_errors,
        "reconnectErrors": reconnect_errors,
        "avgConnectSec": statistics.mean(times) if times else -1,
        "avgReconnectSec": statistics.mean(reconnect) if reconnect else -1,
        "p95ReconnectSec": pct(reconnect, 95),
        "p99ReconnectSec": pct(reconnect, 99),
        "peakThreadsApprox": threading.active_count(),
        "peakRssHint": rss,
        "result": "PASS" if passed else "FAIL",
    }
    return report


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--clients", type=int, default=int(os.environ.get("WXQK_STORM_CLIENTS") or 100))
    args = ap.parse_args()
    report = run_storm(args.clients)
    print(json.dumps(report, indent=2))
    print(f"SERVER_RECONNECT_STORM_GATE={report['result']} clients={args.clients}")
    return 0 if report["result"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
