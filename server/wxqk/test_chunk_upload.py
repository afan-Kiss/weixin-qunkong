# -*- coding: utf-8 -*-
from __future__ import annotations

import hashlib
import tempfile
import unittest
from pathlib import Path

import chunk_upload as cu


class ChunkUploadTests(unittest.TestCase):
    def test_parallel_parts_are_idempotent_and_finish_as_exact_file(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            data_dir = Path(temp)
            payload = (b"facai888-release-" * 90_000) + b"tail"
            started = cu.begin_chunked_upload(data_dir, "build-1", "client.exe", len(payload))
            self.assertTrue(started["ok"])
            chunk_size = int(started["chunkHint"])
            parts = [payload[i:i + chunk_size] for i in range(0, len(payload), chunk_size)]

            # Out-of-order write plus a retried response must be harmless.
            for index in reversed(range(len(parts))):
                self.assertTrue(cu.put_chunked_part(data_dir, "build-1", index, parts[index])["ok"])
            duplicate = cu.put_chunked_part(data_dir, "build-1", 0, parts[0])
            self.assertTrue(duplicate["ok"])
            self.assertTrue(duplicate["duplicate"])

            finished = cu.finish_chunked_upload(data_dir, "build-1")
            self.assertTrue(finished["ok"])
            self.assertEqual(finished["fileSize"], len(payload))
            self.assertEqual(finished["sha256"], hashlib.sha256(payload).hexdigest())
            package = data_dir / "releases" / "packages" / "build-1.exe"
            self.assertEqual(package.read_bytes(), payload)

    def test_finish_rejects_a_short_part(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            data_dir = Path(temp)
            size = cu.PART_CHUNK_SIZE + 10
            self.assertTrue(cu.begin_chunked_upload(data_dir, "build-2", "client.exe", size)["ok"])
            self.assertTrue(cu.put_chunked_part(data_dir, "build-2", 0, b"x" * cu.PART_CHUNK_SIZE)["ok"])
            # A last part must have exactly the expected short length.
            short = cu.put_chunked_part(data_dir, "build-2", 1, b"x" * 9)
            self.assertTrue(short["ok"])
            finished = cu.finish_chunked_upload(data_dir, "build-2")
            self.assertFalse(finished["ok"])
            self.assertIn("缺少分块", finished["message"])

    def test_init_resumes_matching_upload_without_discarding_parts(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            data_dir = Path(temp)
            payload = b"a" * (cu.PART_CHUNK_SIZE + 12)
            self.assertTrue(cu.begin_chunked_upload(data_dir, "build-3", "client.exe", len(payload))["ok"])
            self.assertTrue(cu.put_chunked_part(data_dir, "build-3", 0, payload[:cu.PART_CHUNK_SIZE])["ok"])

            resumed = cu.begin_chunked_upload(data_dir, "build-3", "client.exe", len(payload))
            self.assertTrue(resumed["ok"])
            self.assertTrue(resumed["resumed"])
            self.assertEqual(resumed["uploadedParts"], [0])

            self.assertTrue(cu.put_chunked_part(data_dir, "build-3", 1, payload[cu.PART_CHUNK_SIZE:])["ok"])
            self.assertTrue(cu.finish_chunked_upload(data_dir, "build-3")["ok"])

            complete = cu.begin_chunked_upload(data_dir, "build-3", "client.exe", len(payload))
            self.assertTrue(complete["ok"])
            self.assertEqual(complete["mode"], "complete")

    def test_custom_chunk_size_roundtrip(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            data_dir = Path(temp)
            payload = (b"big-chunk-" * 200_000) + b"end"
            chunk = 2 * 1024 * 1024
            started = cu.begin_chunked_upload(
                data_dir, "build-4mb", "client.exe", len(payload), chunk_size=chunk
            )
            self.assertTrue(started["ok"])
            self.assertEqual(int(started["chunkHint"]), chunk)
            parts = [payload[i:i + chunk] for i in range(0, len(payload), chunk)]
            for index, part in enumerate(parts):
                self.assertTrue(cu.put_chunked_part(data_dir, "build-4mb", index, part)["ok"])
            finished = cu.finish_chunked_upload(data_dir, "build-4mb")
            self.assertTrue(finished["ok"])
            self.assertEqual(finished["sha256"], hashlib.sha256(payload).hexdigest())


if __name__ == "__main__":
    unittest.main()
