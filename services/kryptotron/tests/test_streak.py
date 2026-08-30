import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from streak import can_trade, close_trade, emergency_lock, ensure_session, open_trade


DAY = datetime(2026, 8, 31, 8, tzinfo=timezone.utc)


class StreakTests(unittest.TestCase):
    def test_win_allows_next_trade_and_loss_locks_day(self):
        streak = {"enabled": True}
        open_trade(streak, {"symbol": "BTCUSDC"}, DAY)
        close_trade(streak, 1.2, fees=.1, slippage=.05, now=DAY)
        self.assertEqual(streak["session"]["streak"], 1)
        self.assertTrue(can_trade(streak, DAY)[0])
        open_trade(streak, {"symbol": "ETHUSDC"}, DAY)
        close_trade(streak, -.8, fees=.1, now=DAY)
        self.assertEqual(streak["session"]["status"], "LOCKED")
        self.assertFalse(can_trade(streak, DAY)[0])

    def test_flat_does_not_increment_or_lock(self):
        streak = {"enabled": True}
        open_trade(streak, {}, DAY)
        self.assertEqual(close_trade(streak, .04, now=DAY)["result"], "FLAT")
        self.assertTrue(can_trade(streak, DAY)[0])

    def test_new_prague_day_archives_and_resets_session(self):
        streak = {"enabled": True}
        session = ensure_session(streak, DAY)
        session.update(status="LOCKED", losses=1)
        ensure_session(streak, datetime(2026, 9, 1, 8, tzinfo=timezone.utc))
        self.assertEqual(streak["session"]["status"], "READY")
        self.assertEqual(len(streak["sessions"]), 1)

    def test_emergency_lock_is_fail_closed(self):
        streak = {"enabled": True}
        emergency_lock(streak, "POSITION_MISMATCH", DAY)
        self.assertEqual(can_trade(streak, DAY), (False, "POSITION_MISMATCH"))


if __name__ == "__main__":
    unittest.main()
