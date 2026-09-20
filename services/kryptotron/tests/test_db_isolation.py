import unittest
from unittest.mock import patch
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import db


class PersistenceIsolationTests(unittest.TestCase):
    def setUp(self):
        db._broker_url = ""
        db._broker_headers = {}

    def tearDown(self):
        db._broker_url = ""
        db._broker_headers = {}

    @patch.object(db.requests, "post")
    def test_notification_retries_keep_the_same_id_and_scoped_headers(self, post):
        db._broker_url = "http://127.0.0.1/internal/kryptotron"
        db._broker_headers = {"Authorization": "Bearer scoped"}
        post.side_effect = [db.requests.Timeout(), unittest.mock.Mock()]
        self.assertTrue(db.notify("hello"))
        self.assertEqual(post.call_count, 2)
        first, second = post.call_args_list
        self.assertEqual(first.kwargs["json"]["id"], second.kwargs["json"]["id"])
        self.assertEqual(first.kwargs["headers"], db._broker_headers)
        self.assertEqual(first.args[0], db._broker_url + "/notifications")

    @patch.object(db.requests, "put")
    def test_state_save_uses_broker_only(self, put):
        db._broker_url = "http://localhost/internal/kryptotron"
        db._broker_headers = {"Authorization": "Bearer scoped", "X-Ocean-Instance": "kry_" + "a" * 32}
        self.assertTrue(db.save_state({"balance": 42}))
        put.assert_called_once_with(db._broker_url + "/state", headers=db._broker_headers,
                                    json={"state": {"balance": 42}}, timeout=8)

    @patch.object(db.requests, "post")
    def test_trade_uses_instance_scoped_broker(self, post):
        db._broker_url = "http://localhost/internal/kryptotron"
        db._broker_headers = {"Authorization": "Bearer scoped"}
        db.log_trade("BTCUSDC", 10, 11, 1, 1, "WIN")
        self.assertEqual(post.call_args.args[0], db._broker_url + "/trades")
        self.assertEqual(post.call_args.kwargs["headers"], db._broker_headers)
        self.assertNotIn("instance_id", post.call_args.kwargs["json"])

    @patch.object(db.requests, "get", side_effect=db.requests.Timeout())
    def test_unavailable_remote_state_never_falls_back_to_empty_state(self, get):
        db._broker_url = "http://localhost/internal/kryptotron"
        with self.assertRaises(RuntimeError):
            db.load_state()

    @patch.object(db, "INSTANCE_ID", "main")
    def test_legacy_standalone_start_is_rejected(self):
        with self.assertRaises(RuntimeError):
            db.init()

    @patch.object(db.requests, "get")
    def test_broker_load_uses_scoped_headers(self, get):
        response = get.return_value
        response.status_code = 200
        response.json.return_value = {"state": {"owner": "scoped"}}
        db._broker_url = "http://127.0.0.1/internal/kryptotron"
        db._broker_headers = {"Authorization": "Bearer token", "X-Ocean-Instance": "usr_alpha"}
        self.assertEqual(db.load_state(), {"owner": "scoped"})
        get.assert_called_once_with(
            "http://127.0.0.1/internal/kryptotron/state",
            headers=db._broker_headers,
            timeout=8,
        )


if __name__ == "__main__":
    unittest.main()
