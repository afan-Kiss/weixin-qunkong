import socket
import struct
import unittest

import wsutil


class WebSocketLimitsTest(unittest.TestCase):
    def test_rejects_declared_oversized_frame_before_body_read(self):
        left, right = socket.socketpair()
        try:
            right.sendall(bytes([0x81, 0x7F]) + struct.pack("!Q", wsutil.MAX_MESSAGE_BYTES + 1))
            with self.assertRaisesRegex(ValueError, "too large"):
                wsutil.recv_frame(left)
        finally:
            left.close(); right.close()

    def test_accepts_small_text_frame(self):
        left, right = socket.socketpair()
        try:
            right.sendall(b"\x81\x02{}")
            self.assertEqual(wsutil.recv_message(left), (1, b"{}"))
        finally:
            left.close(); right.close()


if __name__ == "__main__":
    unittest.main()
