"""Minimal synchronous WebSocket helpers (RFC6455 text/binary frames)."""
from __future__ import annotations

import base64
import hashlib
import json
import os
import struct
from typing import Any, Optional


GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
MAX_MESSAGE_BYTES = 8 * 1024 * 1024


def accept_key(sec_key: str) -> str:
    dig = hashlib.sha1((sec_key + GUID).encode("utf-8")).digest()
    return base64.b64encode(dig).decode("ascii")


def handshake_response(sec_key: str) -> bytes:
    ack = accept_key(sec_key)
    return (
        "HTTP/1.1 101 Switching Protocols\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        f"Sec-WebSocket-Accept: {ack}\r\n"
        "\r\n"
    ).encode("ascii")


def _read_exact(sock, n: int) -> bytes:
    buf = b""
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise ConnectionError("socket closed")
        buf += chunk
    return buf


def recv_frame(sock, max_bytes: int = MAX_MESSAGE_BYTES) -> tuple[int, bool, bytes]:
    """Return (opcode, fin, payload). opcode 1=text 2=binary 8=close 9=ping 10=pong."""
    hdr = _read_exact(sock, 2)
    b1, b2 = hdr[0], hdr[1]
    fin = (b1 & 0x80) != 0
    opcode = b1 & 0x0F
    masked = (b2 & 0x80) != 0
    length = b2 & 0x7F
    if length == 126:
        length = struct.unpack("!H", _read_exact(sock, 2))[0]
    elif length == 127:
        length = struct.unpack("!Q", _read_exact(sock, 8))[0]
    if length > max_bytes:
        raise ValueError("websocket frame too large")
    mask = _read_exact(sock, 4) if masked else b""
    payload = _read_exact(sock, length) if length else b""
    if masked:
        payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
    return opcode, fin, payload


def send_frame(sock, opcode: int, payload: bytes = b"", *, mask: bool = False) -> None:
    fin_opcode = 0x80 | (opcode & 0x0F)
    length = len(payload)
    header = bytes([fin_opcode])
    if length < 126:
        header += bytes([length | (0x80 if mask else 0)])
    elif length < 65536:
        header += bytes([126 | (0x80 if mask else 0)]) + struct.pack("!H", length)
    else:
        header += bytes([127 | (0x80 if mask else 0)]) + struct.pack("!Q", length)
    if mask:
        m = os.urandom(4)
        header += m
        payload = bytes(b ^ m[i % 4] for i, b in enumerate(payload))
    sock.sendall(header + payload)


def send_text(sock, text: str) -> None:
    send_frame(sock, 1, text.encode("utf-8"))


def send_json(sock, obj: Any) -> None:
    send_text(sock, json.dumps(obj, ensure_ascii=False, separators=(",", ":")))


def recv_message(sock, max_bytes: int = MAX_MESSAGE_BYTES) -> tuple[int, bytes]:
    """Read one complete data message, reassembling fragmented frames.

    Gorilla websocket (and many clients) split large WriteJSON payloads across
    multiple frames (FIN=0 + continuation). Without reassembly, desktop JPEG
    frames arrive truncated and the dashboard shows a broken image.
    """
    while True:
        opcode, fin, payload = recv_frame(sock, max_bytes)
        if opcode == 8:
            raise ConnectionError("websocket closed")
        if opcode == 9:  # ping
            send_frame(sock, 10, payload)
            continue
        if opcode == 10:  # pong
            continue
        if opcode not in (1, 2):
            # unexpected control/data — skip
            continue

        parts = [payload]
        total = len(payload)
        while not fin:
            opcode2, fin, payload2 = recv_frame(sock, max_bytes)
            if opcode2 == 8:
                raise ConnectionError("websocket closed")
            if opcode2 == 9:
                send_frame(sock, 10, payload2)
                continue
            if opcode2 == 10:
                continue
            if opcode2 != 0:
                raise ConnectionError(f"unexpected opcode {opcode2} while reassembling")
            total += len(payload2)
            if total > max_bytes:
                raise ValueError("websocket message too large")
            parts.append(payload2)
        return opcode, b"".join(parts)


def recv_json(sock, timeout: Optional[float] = None) -> Any:
    if timeout is not None:
        sock.settimeout(timeout)
    while True:
        opcode, payload = recv_message(sock)
        if opcode == 1:
            return json.loads(payload.decode("utf-8"))
        if opcode == 2:
            return payload
