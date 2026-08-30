import unittest
from datetime import datetime, timedelta, timezone

from telegram_control import apply_action, confirmation, confirmation_valid, status_message


class TelegramControlTests(unittest.TestCase):
    def test_status_contains_controls_and_balance(self):
        state = {"account_balance": 73.93, "dca": {"enabled": True}, "streak": {"enabled": True, "session": {"streak": 2}}}
        message = status_message(state)
        self.assertIn("73.93 USDC", message)
        self.assertIn("2 výher", message)

    def test_disabling_is_immediate(self):
        state = {"entries_paused": False, "dca": {"enabled": True}, "streak": {"enabled": True}}
        apply_action(state, "pause")
        apply_action(state, "dca_off")
        apply_action(state, "streak_off")
        self.assertTrue(state["entries_paused"])
        self.assertFalse(state["dca"]["enabled"])
        self.assertFalse(state["streak"]["enabled"])

    def test_enable_confirmation_expires(self):
        now = datetime(2026, 8, 30, tzinfo=timezone.utc)
        pending = confirmation("dca_on", now)
        self.assertTrue(confirmation_valid(pending, "dca_on", now + timedelta(minutes=4)))
        self.assertFalse(confirmation_valid(pending, "dca_on", now + timedelta(minutes=6)))


if __name__ == "__main__":
    unittest.main()
