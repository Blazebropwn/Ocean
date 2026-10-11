import copy
from datetime import datetime, timezone
from unittest.mock import patch

import bot
from test_bot_reconcile import BotStateTestCase


class TradeAccountingEvidenceTests(BotStateTestCase):
    def positioned(self):
        state = self.state()
        state["positions"]["BTCUSDC"] = {"in_position": True, "position_qty": .001,
            "entry_price": 10000, "entry_order_id": 12, "entry_time": "2026-10-01T00:00:00+00:00"}
        return state

    def test_protective_exit_archives_exchange_identity_and_time_in_durable_history(self):
        state = self.positioned()
        at = datetime(2026, 10, 11, tzinfo=timezone.utc)
        with patch.object(bot, "now_utc", return_value=at):
            bot.close_from_protection(state, "BTCUSDC", {"quantity": .001, "exit_price": 11000,
                "reason": "TRAILING_STOP", "order": {"orderId": 13, "updateTime": at.timestamp() * 1000}})
        record = state["pending_trade_logs"][0]
        self.assertEqual(record["execution"], {"entryOrderId": 12, "exitOrderId": 13})
        self.assertEqual(record["exit_time"], at.isoformat())
        self.assertEqual(state["trade_explanations"][-1]["exitOrderId"], 13)
        self.assertEqual(record["pnl"], 1)
        self.assertEqual(state["last_trade_result"], "WIN")
        self.assertEqual(state["daily_loss"], 0)

    def test_failed_protection_settlement_preserves_open_position_and_no_duplicate_evidence(self):
        state = self.positioned()
        bot.get_pair_state(state, "BTCUSDC")
        before = copy.deepcopy(state)
        outcome = {"quantity": .001, "exit_price": 9000, "reason": "EMERGENCY_STOP", "order": {"orderId": 13}}
        with patch.object(bot, "save_state", return_value=False):
            with self.assertRaises(RuntimeError):
                bot.close_from_protection(state, "BTCUSDC", outcome)
        self.assertEqual(state["positions"], before["positions"])
        self.assertNotIn("pending_trade_logs", state)
        self.assertNotIn("trade_explanations", state)

    def test_legacy_missing_order_ids_are_preserved_as_unknown(self):
        state = self.positioned()
        del state["positions"]["BTCUSDC"]["entry_order_id"]
        bot.record_close(state, "BTCUSDC", 9000, "DEATH_CROSS")
        self.assertEqual(state["pending_trade_logs"][0]["execution"], {"entryOrderId": None, "exitOrderId": None})
        self.assertEqual(state["daily_loss"], 1)
        self.assertEqual(state["last_trade_result"], "LOSS")
