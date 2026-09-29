import copy
from datetime import datetime, timezone, timedelta
import unittest
from unittest.mock import Mock, patch

from test_bot_reconcile import BotStateTestCase, FakeGetOrderClient, binance_error
import bot
from reconciliation import inspect_account
from risk import entry_permission, decision_snapshot, position_budget
from order_safety import apply_filled_buy, classify_order
from dca import settle_pending_dca

NOW = datetime(2026, 9, 26, 12, tzinfo=timezone.utc)


class AccountInvariants(unittest.TestCase):
    def setUp(self):
        self.state = {"positions": {"BTCUSDC": {"in_position": True, "position_qty": .01,
                                               "protection_order_list_id": 4}}}
        self.pairs = [{"symbol": "BTCUSDC", "base": "BTC", "step_size": .000001}]
        self.client = Mock()
        self.client.get_account.return_value = {"canTrade": True, "balances": [
            {"asset": "BTC", "free": "0", "locked": ".01"},
            {"asset": "USDC", "free": "100", "locked": "20"}]}
        self.orders = [{"symbol": "BTCUSDC", "side": "SELL", "status": "NEW", "orderListId": 4,
                        "origQty": ".01", "executedQty": "0", "clientOrderId": prefix + "test"}
                       for prefix in ("ocean-stop-", "ocean-trail-")]
        self.client.get_open_orders.return_value = self.orders

    def inspect(self):
        return inspect_account(self.client, self.state, self.pairs, now=NOW)

    def test_exchange_balances_and_two_branches_confirm_position(self):
        result = self.inspect()
        self.assertEqual(result["status"], "OK")
        self.assertEqual(result["available_quote"], 100)
        self.assertEqual([call[0] for call in self.client.mock_calls], ["get_account", "get_open_orders"])

    def test_missing_or_partial_protection_is_not_healthy(self):
        self.orders.pop()
        self.assertEqual(self.inspect()["issues"][0]["code"], "PROTECTION_ERROR")

    def test_recorded_position_absent_on_exchange_blocks_entry(self):
        self.client.get_account.return_value["balances"][0]["locked"] = "0"
        self.assertIn("POSITION_BALANCE_MISMATCH", [i["code"] for i in self.inspect()["issues"]])

    def test_unknown_order_and_pending_are_visible(self):
        self.orders.append({"symbol": "BTCUSDC", "orderListId": -1, "clientOrderId": "unknown"})
        self.state["pending_order"] = {"client_order_id": "other"}
        codes = [i["code"] for i in self.inspect()["issues"]]
        self.assertIn("UNKNOWN_OPEN_ORDER", codes)
        self.assertIn("PENDING_EXECUTION", codes)

    def test_partial_protective_fill_requires_review(self):
        self.orders[0].update(status="PARTIALLY_FILLED", executedQty=".005")
        self.assertEqual(self.inspect()["status"], "UNRESOLVED")

    def test_invalid_balance_is_never_a_fresh_account(self):
        self.client.get_account.return_value["balances"][0]["free"] = "NaN"
        with self.assertRaises(ValueError):
            self.inspect()

    def test_unattributed_inventory_requires_review_until_explicitly_classified(self):
        self.client.get_account.return_value["balances"][0]["free"] = ".02"
        self.assertIn("UNATTRIBUTED_BALANCE", [i["code"] for i in self.inspect()["issues"]])
        self.state["unmanaged_inventory"] = {"BTC": .02}
        self.assertEqual(self.inspect()["status"], "OK")


class RiskInvariants(unittest.TestCase):
    def state(self):
        return {"entries_paused": False, "reconciliation": {"status": "OK", "checked_at": NOW.isoformat()},
                "daily_loss": 0, "weekly_loss": 0, "trades_today": 0, "trades_week": 0}

    def test_all_entry_guards_have_explicit_codes(self):
        cases = [({"entries_paused": True}, "ENTRIES_PAUSED"), ({"safe_mode": True}, "RECONCILIATION_REQUIRED"),
                 ({"daily_loss": 5}, "DAILY_LOSS_LIMIT"), ({"weekly_loss": 15}, "WEEKLY_LOSS_LIMIT"),
                 ({"trades_today": 3}, "DAILY_TRADE_LIMIT"), ({"trades_week": 9}, "WEEKLY_TRADE_LIMIT"),
                 ({"pending_order": {"side": "BUY"}}, "RECONCILIATION_REQUIRED"),
                 ({"pending_trade_logs": [{}]}, "PERSISTENCE_REQUIRED"),
                 ({"last_trade_time": (NOW-timedelta(hours=1)).isoformat(), "last_trade_result": "WIN"}, "COOLDOWN_ACTIVE")]
        for update, code in cases:
            with self.subTest(code=code):
                self.assertEqual(entry_permission({**self.state(), **update}, NOW)[0], code)

    def test_freshness_and_risk_values_fail_closed(self):
        state = self.state()
        state["reconciliation"]["checked_at"] = (NOW-timedelta(seconds=91)).isoformat()
        self.assertEqual(entry_permission(state, NOW)[0], "STALE_STATE")
        self.assertEqual(entry_permission({**self.state(), "daily_loss": float("nan")}, NOW)[0], "STALE_STATE")

    def test_sizing_never_raises_existing_allocation(self):
        self.assertEqual(position_budget(100), 25)
        self.assertEqual(position_budget(10000), 50)

    def test_snapshot_reason_matches_gate_and_known_market(self):
        data = {"bull": True, "death_cross": False, "close": 100, "ema_fast": 95, "ema_slow": 90}
        decision = decision_snapshot({**self.state(), "daily_loss": 5}, "BTCUSDC", data, NOW, minimum=5, free_quote=100)
        self.assertEqual(decision["reasonCode"], "DAILY_LOSS_LIMIT")
        self.assertEqual(decision["decision"], "NO_ENTRY")


class ExecutionInvariants(BotStateTestCase):
    def test_entry_protection_restart_pause_resume_and_exit_lifecycle(self):
        state = self.state()
        state.update(entries_paused=False, safe_mode=False, daily_loss_date="2026-09-26")
        persisted = []
        bot.db.save_state = lambda value: persisted.append(copy.deepcopy(value)) or True
        client = Mock()
        balance = {"canTrade": True, "balances": [{"asset": "BTC", "free": "0", "locked": "0"},
                                                      {"asset": "USDC", "free": "100", "locked": "0"}]}
        orders = []
        client.get_account.side_effect = lambda: copy.deepcopy(balance)
        client.get_open_orders.side_effect = lambda: copy.deepcopy(orders)
        client.get_asset_balance.return_value = {"free": ".001"}
        filters = {"BTCUSDC": (.000001, .01, 5)}
        with patch.object(bot, "now_utc", return_value=NOW):
            self.assertTrue(bot.reconcile_account(client, state, filters))
            self.assertTrue(bot.can_trade(state)[0])
            intent = bot.new_buy_intent("BTCUSDC", 10)
            intent["created_at"] = NOW.isoformat()
            state["pending_order"] = intent
            self.assertTrue(bot.save_state(state))
            filled = {"status": "FILLED", "orderId": 12, "executedQty": ".001", "cummulativeQuoteQty": "10", "fills": []}
            ps = apply_filled_buy(state, intent, filled)
            balance["balances"][0]["free"] = ".001"
            balance["balances"][1]["free"] = "90"
            client.create_oco_order.return_value = {"orderListId": 4}
            self.assertTrue(bot.secure_protection_or_exit(client, state, "BTCUSDC", ps, "BTC", .000001, .01, (10, 2000)))
            request = client.create_oco_order.call_args.kwargs
            orders.extend([{ "symbol": "BTCUSDC", "side": "SELL", "status": "NEW", "orderListId": 4,
                            "orderId": index, "origQty": ".001", "executedQty": "0",
                            "clientOrderId": request[key] } for index, key in [(20,"aboveClientOrderId"),(21,"belowClientOrderId")]])
            balance["balances"][0].update(free="0", locked=".001")
            client.v3_get_order_list.return_value = {"listOrderStatus": "EXECUTING", "orders": [{"orderId": 20},{"orderId":21}]}
            client.get_order.side_effect = lambda **kw: next(order for order in orders if order["orderId"] == kw["orderId"])
            # A restarted worker uses the saved broker state, not an empty position.
            state = copy.deepcopy(persisted[-1])
            self.assertTrue(bot.reconcile_account(client, state, filters))
            self.assertEqual(client.create_oco_order.call_count, 1)
            state["entries_paused"] = True
            self.assertFalse(bot.can_trade(state)[0])
            state["entries_paused"] = False
            self.assertTrue(bot.can_trade(state)[0])
            client.v3_get_order_list.return_value = {"listOrderStatus": "ALL_DONE", "orders": [{"orderId":20},{"orderId":21}]}
            for order in orders: order["status"] = "CANCELED"
            bot.clear_protection(state["positions"]["BTCUSDC"])
            client.order_market_sell.return_value = {"status": "FILLED", "orderId": 13, "executedQty": ".001", "cummulativeQuoteQty": "11"}
            bot.execute_market_exit(client, state, "BTCUSDC", .000001, "DEATH_CROSS")
            self.assertFalse(state["positions"]["BTCUSDC"]["in_position"])
            self.assertEqual(client.order_market_sell.call_count, 1)
            self.assertEqual(len(persisted[-1]["pending_trade_logs"]), 1)
            self.assertEqual(entry_permission(state, NOW)[0], "PERSISTENCE_REQUIRED")

    def test_terminal_partial_buy_is_recorded_not_forgotten(self):
        state = self.state()
        intent = bot.new_buy_intent("BTCUSDC", 25)
        order = {"status": "CANCELED", "orderId": 1, "executedQty": ".001", "cummulativeQuoteQty": "10"}
        state["pending_order"] = intent
        self.assertEqual(classify_order(order), "settled_partial")
        bot.reconcile_pending_order(FakeGetOrderClient(order=order), state)
        self.assertTrue(state["positions"]["BTCUSDC"]["in_position"])
        self.assertEqual(state["positions"]["BTCUSDC"]["position_qty"], .001)

    def test_base_commission_is_not_offered_for_protection(self):
        state = self.state()
        order = {"status": "FILLED", "executedQty": ".001", "cummulativeQuoteQty": "10",
                 "fills": [{"commissionAsset": "BTC", "commission": ".000001"}]}
        ps = apply_filled_buy(state, bot.new_buy_intent("BTCUSDC", 10), order)
        self.assertAlmostEqual(ps["position_qty"], .000999)

    def test_another_buy_cannot_replace_an_existing_position(self):
        state = self.state()
        order = {"status": "FILLED", "executedQty": ".001", "cummulativeQuoteQty": "10"}
        apply_filled_buy(state, bot.new_buy_intent("BTCUSDC", 10), order)
        with self.assertRaisesRegex(RuntimeError, "otevřenou pozici"):
            apply_filled_buy(state, bot.new_buy_intent("BTCUSDC", 10), order)

    def test_persistence_failure_retains_buy_intent(self):
        state = self.state()
        state["pending_order"] = bot.new_buy_intent("BTCUSDC", 25)
        order = {"status": "FILLED", "orderId": 1, "executedQty": ".001", "cummulativeQuoteQty": "25"}
        bot.db.save_state = lambda _: False
        with self.assertRaises(RuntimeError):
            bot.reconcile_pending_order(FakeGetOrderClient(order=order), state)
        self.assertIsNotNone(state["pending_order"])
        self.assertTrue(state["safe_mode"])

    def test_sell_timeout_reconciles_by_same_id_without_resubmission(self):
        state = self.state()
        state["positions"]["BTCUSDC"] = {"in_position": True, "position_qty": .001, "entry_price": 10000,
                                                "entry_time": None}
        client = Mock()
        client.order_market_sell.side_effect = TimeoutError("ambiguous")
        with self.assertRaises(TimeoutError):
            bot.execute_market_exit(client, state, "BTCUSDC", .000001, "DEATH_CROSS")
        intent = copy.deepcopy(state["pending_order"])
        client.get_order.return_value = {"status": "FILLED", "executedQty": ".001", "cummulativeQuoteQty": "11"}
        bot.reconcile_pending_order(client, state)
        self.assertFalse(state["positions"]["BTCUSDC"]["in_position"])
        self.assertIsNone(state["pending_order"])
        self.assertEqual(client.order_market_sell.call_count, 1)
        client.get_order.assert_called_once_with(symbol="BTCUSDC", origClientOrderId=intent["client_order_id"])
        self.assertEqual(len(state["pending_trade_logs"]), 1)

    def test_partial_sell_never_marks_whole_position_closed(self):
        state = self.state()
        intent = {"side": "SELL", "symbol": "BTCUSDC", "quantity": .001, "reason": "DEATH_CROSS"}
        state["pending_order"] = intent
        with self.assertRaises(RuntimeError):
            bot.finalize_market_exit(state, intent, {"status": "CANCELED", "executedQty": ".0005", "cummulativeQuoteQty": "5"})
        self.assertEqual(state["pending_order"], intent)

    def test_invalid_partial_quantity_cannot_be_classified_as_zero_fill(self):
        with self.assertRaises(ValueError):
            classify_order({"status": "CANCELED", "executedQty": "NaN"})

    def test_dca_pending_from_prior_week_is_resolved_without_new_order(self):
        state = {"dca": {"pending": {"symbol": "BTCUSDC", "week": "2026-W01", "amount": 5, "client_order_id": "old"}}}
        client = Mock()
        client.get_order.return_value = {"status": "FILLED", "orderId": 1, "executedQty": ".001", "cummulativeQuoteQty": "5"}
        client.get_my_trades.return_value = [{"qty": ".001", "commission": "0", "commissionAsset": "USDC"}]
        settle_pending_dca(client, state, lambda _: True)
        self.assertIsNone(state["dca"]["pending"])
        client.order_market_buy.assert_not_called()
        self.assertEqual(state["dca"]["recorded_totals"]["BTCUSDC"]["spent"], 5)
