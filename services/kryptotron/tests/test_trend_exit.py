"""A missed crossing is recoverable without bypassing exchange/persistence guards."""
from datetime import datetime, timezone
from unittest.mock import Mock, patch
import copy
import unittest

from test_bot_reconcile import BotStateTestCase
import bot
from risk import decision_snapshot, trend_exit_reason

NOW = datetime(2026, 11, 2, tzinfo=timezone.utc)
BEAR = {"bull": False, "death_cross": False, "ema_fast": 90, "ema_slow": 100, "close": 88}


class TrendExitTests(BotStateTestCase):
    def open_state(self):
        state = self.state()
        state.update(entries_paused=True, trading_paused=True, safe_mode=False, api_permissions_safe=True)
        state["positions"]["BTCUSDC"] = {"in_position": True, "position_qty": .001,
            "entry_price": 100, "protection_client_id": "ocean-protect-test", "protection_status": "ACTIVE"}
        return state

    def test_persisted_position_exits_bear_regime_after_crossing_was_missed(self):
        # Reconstructed state represents a restart after the crossing candle.
        state = copy.deepcopy(self.open_state())
        client = Mock()
        with patch.object(bot, "sync_protection", side_effect=[{"status": "active"}, {"status": "cancelled"}]), \
                patch.object(bot, "cancel_protection") as cancel, \
                patch.object(bot, "execute_market_exit") as sell:
            self.assertTrue(bot.process_trend_exit(client, state, "BTCUSDC", BEAR, .00001))
        cancel.assert_called_once_with(client, "BTCUSDC", "ocean-protect-test")
        sell.assert_called_once_with(client, state, "BTCUSDC", .00001, "BEAR_REGIME_EXIT")

    def test_snapshot_and_executor_use_same_exit_reason(self):
        state = self.open_state()
        for crossed, code in ((False, "BEAR_REGIME_EXIT"), (True, "DEATH_CROSS")):
            data = {**BEAR, "death_cross": crossed}
            snapshot = decision_snapshot(state, "BTCUSDC", data, NOW)
            self.assertEqual((snapshot["decision"], snapshot["reasonCode"]), ("EXIT_REQUIRED", code))
            self.assertEqual(trend_exit_reason(data), code)

    def test_bull_or_equal_emas_never_cancel_existing_protection(self):
        for fast in (100, 101):
            with patch.object(bot, "cancel_protection_for_market_exit") as cancel:
                self.assertFalse(bot.process_trend_exit(Mock(), self.open_state(), "BTCUSDC",
                    {**BEAR, "ema_fast": fast, "bull": fast > 100}, .00001))
                cancel.assert_not_called()

    def test_invalid_ema_blocks_instead_of_generating_sell_signal(self):
        for value in (None, 0, -1, float("nan"), float("inf"), True, "90"):
            with self.subTest(value=value), patch.object(bot, "cancel_protection_for_market_exit") as cancel:
                with self.assertRaises(ValueError):
                    bot.process_trend_exit(Mock(), self.open_state(), "BTCUSDC", {**BEAR, "ema_fast": value}, .00001)
                cancel.assert_not_called()

    def test_unverified_or_pending_state_never_cancels_protection(self):
        for fields in ({"safe_mode": True}, {"api_permissions_safe": False},
                       {"pending_order": {"symbol": "ETHUSDC"}}, {"pending_protection": {"id": "pending"}},
                       {"dca": {"pending": {"id": "pending"}}}):
            state = {**self.open_state(), **fields}
            with self.subTest(fields=fields), patch.object(bot, "cancel_protection_for_market_exit") as cancel:
                with self.assertRaises(RuntimeError):
                    bot.process_trend_exit(Mock(), state, "BTCUSDC", BEAR, .00001)
                cancel.assert_not_called()

    def test_manual_close_and_restore_keep_ownership_of_the_same_position(self):
        for field in ("manual_close", "protection_restore"):
            state = {**self.open_state(), field: {"status": "queued", "symbol": "BTCUSDC"}}
            with self.subTest(field=field), patch.object(bot, "cancel_protection_for_market_exit") as cancel:
                self.assertFalse(bot.process_trend_exit(Mock(), state, "BTCUSDC", BEAR, .00001))
                cancel.assert_not_called()

    def test_unconfirmed_cancellation_never_sends_market_sell(self):
        with patch.object(bot, "sync_protection", side_effect=[{"status": "active"}, {"status": "active"}]), \
                patch.object(bot, "cancel_protection"), patch.object(bot, "execute_market_exit") as sell:
            with self.assertRaisesRegex(RuntimeError, "Zrušení ochrany nebylo potvrzeno"):
                bot.process_trend_exit(Mock(), self.open_state(), "BTCUSDC", BEAR, .00001)
            sell.assert_not_called()

    def test_protective_fill_during_exit_never_sends_second_sell(self):
        state = self.open_state()
        with patch.object(bot, "sync_protection", return_value={"status": "filled"}), \
                patch.object(bot, "close_from_protection", return_value=state) as settle, \
                patch.object(bot, "execute_market_exit") as sell:
            self.assertFalse(bot.process_trend_exit(Mock(), state, "BTCUSDC", BEAR, .00001))
            settle.assert_called_once()
            sell.assert_not_called()



if __name__ == "__main__":
    unittest.main()
