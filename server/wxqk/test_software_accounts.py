import tempfile
import unittest
from pathlib import Path

import software_accounts as accounts


class SoftwareAccountsTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.data = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def test_complete_account_lifecycle(self):
        created = accounts.register(self.data, "test_user", "password123")
        token = created["token"]
        account_id = created["account"]["id"]
        self.assertEqual(accounts.session(self.data, token)["username"], "test_user")
        with self.assertRaisesRegex(accounts.AccountError, "已注册"):
            accounts.register(self.data, "test_user", "password123")
        accounts.set_status(self.data, account_id, False)
        self.assertIsNone(accounts.session(self.data, token))
        with self.assertRaisesRegex(accounts.AccountError, "禁用"):
            accounts.login(self.data, "test_user", "password123")
        accounts.set_status(self.data, account_id, True)
        accounts.reset_password(self.data, account_id, "newpassword123")
        with self.assertRaisesRegex(accounts.AccountError, "不正确"):
            accounts.login(self.data, "test_user", "password123")
        fresh = accounts.login(self.data, "test_user", "newpassword123")
        accounts.delete_account(self.data, account_id)
        self.assertIsNone(accounts.session(self.data, fresh["token"]))

    def test_validation_and_logout(self):
        with self.assertRaisesRegex(accounts.AccountError, "4至32"):
            accounts.register(self.data, "a", "password123")
        result = accounts.register(self.data, "normal_user", "password123")
        accounts.logout(self.data, result["token"])
        self.assertIsNone(accounts.session(self.data, result["token"]))


if __name__ == "__main__":
    unittest.main()
