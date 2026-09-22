import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import bot
from binance.exceptions import BinanceAPIException


def binance_error(code, msg="chyba"):
    return BinanceAPIException(None, 400, json.dumps({"code": code, "msg": msg}))


class FakeGetOrderClient:
    def __init__(self, order=None, error=None):
        self.order = order
        self.error = error
        self.calls = []

    def get_order(self, **params):
        self.calls.append(params)
        if self.error:
            raise self.error
        return self.order


class FakeProtectionClient:
    def __init__(self, oco_error=None):
        self.oco_error = oco_error
        self.oco_calls = 0
        self.sell_calls = 0

    def get_asset_balance(self, asset):
        return {"free": "0.001"}

    def create_oco_order(self, **kwargs):
        self.oco_calls += 1
        if self.oco_error:
            raise self.oco_error
        return {"orderListId": 1}

    def order_market_sell(self, **kwargs):
        self.sell_calls += 1
        return {"fills": [{"qty": "0.001", "price": "90000"}]}


class BotStateTestCase(unittest.TestCase):
    def setUp(self):
        self._orig_save_state = bot.db.save_state
        self._orig_notify = bot.db.notify
        self._orig_log_trade = bot.db.log_trade
        self._orig_state_file = bot.STATE_FILE
        bot.db.save_state = lambda state: True
        bot.db.notify = lambda message: False
        bot.db.log_trade = lambda *args, **kwargs: None
        self._tmpdir = tempfile.TemporaryDirectory()
        bot.STATE_FILE = Path(self._tmpdir.name) / "state.json"
        self.addCleanup(self._restore)

    def _restore(self):
        bot.db.save_state = self._orig_save_state
        bot.db.notify = self._orig_notify
        bot.db.log_trade = self._orig_log_trade
        bot.STATE_FILE = self._orig_state_file
        self._tmpdir.cleanup()

    def state(self):
        return {"positions": {}, "pending_order": None, "pending_protection": None,
                "last_trade_time": None, "trades_today": 0, "trades_week": 0,
                "last_trade_result": None, "consecutive_losses": 0,
                "daily_loss": 0.0, "weekly_loss": 0.0, "telegram": {}}


class ReconcilePendingOrderTests(BotStateTestCase):
    def test_no_pending_order_is_a_noop(self):
        client = FakeGetOrderClient()
        state = self.state()
        result = bot.reconcile_pending_order(client, state)
        self.assertIs(result, state)
        self.assertEqual(client.calls, [])

    def test_filled_order_is_applied_and_pending_is_cleared(self):
        intent = bot.new_buy_intent("BTCUSDC", 25)
        state = self.state()
        state["pending_order"] = intent
        order = {"status": "FILLED", "orderId": 1, "executedQty": "0.001", "cummulativeQuoteQty": "90"}
        client = FakeGetOrderClient(order=order)
        result = bot.reconcile_pending_order(client, state)
        self.assertIsNone(result["pending_order"])
        self.assertTrue(result["positions"]["BTCUSDC"]["in_position"])

    def test_terminal_failure_clears_pending_order_without_opening_position(self):
        intent = bot.new_buy_intent("BTCUSDC", 25)
        state = self.state()
        state["pending_order"] = intent
        order = {"status": "REJECTED"}
        client = FakeGetOrderClient(order=order)
        result = bot.reconcile_pending_order(client, state)
        self.assertIsNone(result["pending_order"])
        self.assertNotIn("BTCUSDC", result["positions"])

    def test_order_still_open_keeps_pending_and_raises(self):
        intent = bot.new_buy_intent("BTCUSDC", 25)
        state = self.state()
        state["pending_order"] = intent
        order = {"status": "NEW"}
        client = FakeGetOrderClient(order=order)
        with self.assertRaises(RuntimeError):
            bot.reconcile_pending_order(client, state)
        self.assertEqual(state["pending_order"], intent)

    def test_order_never_created_on_binance_clears_pending_order(self):
        """Regression: a buy rejected outright (e.g. -1013 NOTIONAL) before an
        order ever existed must not permanently block can_trade() for every pair."""
        intent = bot.new_buy_intent("BTCUSDC", 25)
        state = self.state()
        state["pending_order"] = intent
        client = FakeGetOrderClient(error=binance_error(-2013, "Order does not exist."))
        result = bot.reconcile_pending_order(client, state)
        self.assertIsNone(result["pending_order"])
        allowed, _reason = bot.can_trade(result)
        self.assertTrue(allowed)

    def test_unrelated_binance_error_propagates_and_keeps_pending(self):
        intent = bot.new_buy_intent("BTCUSDC", 25)
        state = self.state()
        state["pending_order"] = intent
        client = FakeGetOrderClient(error=binance_error(-1021, "Timestamp mimo okno"))
        with self.assertRaises(BinanceAPIException):
            bot.reconcile_pending_order(client, state)
        self.assertEqual(state["pending_order"], intent)


class SecureProtectionOrExitTests(BotStateTestCase):
    def position(self):
        return {"position_qty": 0.001, "entry_price": 90000.0, "protection_failures": 0,
                "in_position": True, "entry_time": None}

    def test_placement_succeeds_and_resets_failure_counter(self):
        ps = self.position()
        ps["protection_failures"] = 1
        client = FakeProtectionClient()
        result = bot.secure_protection_or_exit(client, self.state(), "BTCUSDC", ps, "BTC", 0.000001, 0.01, (10, 2000))
        self.assertTrue(result)
        self.assertEqual(ps["protection_failures"], 0)
        self.assertEqual(client.sell_calls, 0)

    def test_first_failure_raises_without_forcing_an_exit(self):
        ps = self.position()
        client = FakeProtectionClient(oco_error=RuntimeError("Binance nedostupná"))
        with self.assertRaises(RuntimeError):
            bot.secure_protection_or_exit(client, self.state(), "BTCUSDC", ps, "BTC", 0.000001, 0.01, (10, 2000))
        self.assertEqual(ps["protection_failures"], 1)
        self.assertEqual(client.sell_calls, 0)
        self.assertTrue(ps["in_position"])

    def test_repeated_failure_forces_emergency_market_exit(self):
        """Regression: a position must never sit unprotected indefinitely just
        because OCO placement keeps failing."""
        ps = self.position()
        ps["protection_failures"] = bot.MAX_PROTECTION_FAILURES - 1
        state = self.state()
        state["positions"]["BTCUSDC"] = ps
        client = FakeProtectionClient(oco_error=RuntimeError("Filter selhal"))
        result = bot.secure_protection_or_exit(client, state, "BTCUSDC", ps, "BTC", 0.000001, 0.01, (10, 2000))
        self.assertFalse(result)
        self.assertEqual(client.sell_calls, 1)
        self.assertFalse(ps["in_position"])
        self.assertEqual(ps["protection_failures"], 0)


if __name__ == "__main__":
    unittest.main()
