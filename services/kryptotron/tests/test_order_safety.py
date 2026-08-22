import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from order_safety import apply_filled_buy, classify_order, new_buy_intent


class OrderSafetyTests(unittest.TestCase):
    def state(self):
        return {"positions": {}, "pending_order": None, "last_trade_time": None, "trades_today": 0, "trades_week": 0}

    def test_intent_has_stable_binance_client_id(self):
        intent = new_buy_intent("BTCUSDC", 25)
        self.assertTrue(intent["client_order_id"].startswith("ocean-buy-btcusdc-"))
        self.assertLessEqual(len(intent["client_order_id"]), 36)

    def test_filled_buy_is_applied_only_once(self):
        state = self.state()
        intent = new_buy_intent("BTCUSDC", 25)
        state["pending_order"] = intent
        order = {"status": "FILLED", "orderId": 42, "executedQty": "0.001", "cummulativeQuoteQty": "25"}
        apply_filled_buy(state, intent, order)
        state["pending_order"] = intent
        apply_filled_buy(state, intent, order)
        self.assertEqual(state["trades_today"], 1)
        self.assertEqual(state["positions"]["BTCUSDC"]["entry_price"], 25000)
        self.assertIsNone(state["pending_order"])

    def test_unresolved_order_is_not_treated_as_failed(self):
        self.assertEqual(classify_order({"status": "NEW"}), "pending")
        self.assertEqual(classify_order({"status": "FILLED"}), "filled")
        self.assertEqual(classify_order({"status": "REJECTED"}), "failed")


if __name__ == "__main__":
    unittest.main()
