import unittest
from unittest.mock import patch
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import db


class Query:
    def __init__(self, calls, table):
        self.calls = calls
        self.table = table
        self.data = [{"data": {"owner": "correct"}}]

    def select(self, value):
        self.calls.append((self.table, "select", value))
        return self

    def eq(self, column, value):
        self.calls.append((self.table, "eq", column, value))
        return self

    def upsert(self, value):
        self.calls.append((self.table, "upsert", value))
        return self

    def insert(self, value):
        self.calls.append((self.table, "insert", value))
        return self

    def execute(self):
        return self


class Client:
    def __init__(self):
        self.calls = []

    def table(self, name):
        return Query(self.calls, name)


class PersistenceIsolationTests(unittest.TestCase):
    def setUp(self):
        self.client = Client()
        db._sb = self.client

    def tearDown(self):
        db._sb = None

    @patch.object(db, "INSTANCE_ID", "usr_alpha")
    def test_state_is_loaded_and_saved_only_for_configured_instance(self):
        self.assertEqual(db.load_state(), {"owner": "correct"})
        self.assertTrue(db.save_state({"balance": 42}))
        self.assertIn(("bot_state", "eq", "key", "usr_alpha"), self.client.calls)
        self.assertIn(("bot_state", "upsert", {"key": "usr_alpha", "data": {"balance": 42}, "updated_at": unittest.mock.ANY}), self.client.calls)

    @patch.object(db, "INSTANCE_ID", "usr_alpha")
    def test_trade_is_tagged_with_configured_instance(self):
        db.log_trade("BTCUSDC", 10, 11, 1, 1, "WIN")
        inserts = [call[2] for call in self.client.calls if call[:2] == ("bot_trades", "insert")]
        self.assertEqual(inserts[0]["instance_id"], "usr_alpha")


if __name__ == "__main__":
    unittest.main()
