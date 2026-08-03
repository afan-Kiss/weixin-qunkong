#!/usr/bin/env python3
import unittest

from predictor_ws import matches_subscription


class TestPredictorFilter(unittest.TestCase):
    def test_all(self):
        sub = {"all": True, "clientInstanceId": "", "userId": ""}
        self.assertTrue(matches_subscription(sub, client_instance_id="c1", user_id="u1"))

    def test_by_client(self):
        sub = {"all": False, "clientInstanceId": "cid_a", "userId": ""}
        self.assertTrue(matches_subscription(sub, client_instance_id="cid_a", user_id="x"))
        self.assertFalse(matches_subscription(sub, client_instance_id="cid_b", user_id="x"))

    def test_by_user(self):
        sub = {"all": False, "clientInstanceId": "", "userId": "hash1"}
        self.assertTrue(matches_subscription(sub, client_instance_id="any", user_id="hash1"))
        self.assertFalse(matches_subscription(sub, client_instance_id="any", user_id="hash2"))


if __name__ == "__main__":
    unittest.main()
