import unittest
from unittest.mock import Mock
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from utils import refresh_account_balance


class AccountBalanceTests(unittest.TestCase):
    def test_deposit_appears_without_market_check_and_locked_funds_are_excluded(self):
        client = Mock()
        client.get_asset_balance.return_value = {"free": "89.01516835", "locked": "7"}
        state = {"account_balance": 0.03575917, "entries_paused": False,
                 "next_check_at": "2026-09-20T20:00:30Z", "account_balance_error": "old error"}
        self.assertTrue(refresh_account_balance(client, state))
        self.assertEqual(state["account_balance"], 89.01516835)
        self.assertIsNotNone(state["account_balance_at"])
        self.assertIsNone(state["account_balance_error"])
        self.assertEqual(state["next_check_at"], "2026-09-20T20:00:30Z")
        self.assertFalse(state["entries_paused"])
        client.get_asset_balance.assert_called_once_with(asset="USDC")
        self.assertEqual([call[0] for call in client.mock_calls], ["get_asset_balance"])

    def test_failure_keeps_last_successful_value_and_timestamp(self):
        client = Mock()
        client.get_asset_balance.side_effect = RuntimeError("unavailable")
        state = {"account_balance": 89, "account_balance_at": "2026-09-20T16:00:00Z"}
        self.assertFalse(refresh_account_balance(client, state))
        self.assertEqual(state["account_balance"], 89)
        self.assertEqual(state["account_balance_at"], "2026-09-20T16:00:00Z")
        self.assertIsNotNone(state["account_balance_error"])

    def test_invalid_balance_is_not_published_and_zero_is_valid(self):
        client = Mock()
        for invalid in ["NaN", "Infinity", "-1"]:
            client.get_asset_balance.return_value = {"free": invalid}
            state = {}
            self.assertFalse(refresh_account_balance(client, state))
            self.assertNotIn("account_balance_at", state)
        client.get_asset_balance.return_value = {"free": "0"}
        self.assertTrue(refresh_account_balance(client, state))
        self.assertEqual(state["account_balance"], 0)
        self.assertIsNone(state["account_balance_error"])
