import copy
from datetime import datetime, timedelta, timezone
from unittest.mock import Mock, patch

from test_bot_reconcile import BotStateTestCase, binance_error
import bot
from risk import entry_permission

NOW = datetime(2026, 9, 29, 12, tzinfo=timezone.utc)
FILTERS = {"BTCUSDC": (.000001, .01, 5)}
FILL = {"status": "FILLED", "executedQty": ".001", "cummulativeQuoteQty": "11"}


class ManualCloseTests(BotStateTestCase):
    def state(self):
        state = super().state()
        state.update(entries_paused=True, safe_mode=False, api_permissions_safe=True,
                     reconciliation={"status": "OK", "checked_at": NOW.isoformat()},
                     manual_close={"id": "request-1", "symbol": "BTCUSDC", "position_id": "entry-1",
                                   "status": "queued", "requested_at": NOW.isoformat()},
                     dca={"purchases": [{"symbol": "BTCUSDC", "quantity": .003}]},
                     unmanaged_inventory={"BTC": "1"})
        state["positions"]["BTCUSDC"] = {"in_position": True, "position_qty": .001, "entry_price": 10000,
            "entry_time": (NOW-timedelta(days=1)).isoformat(), "entry_order_client_id": "entry-1",
            "protection_status": "ACTIVE", "protection_client_id": "oco-1"}
        state["positions"]["ETHUSDC"] = {"in_position": True, "position_qty": 1, "entry_price": 1000}
        return state

    def setup_exchange(self, outcomes=None):
        self.clock = patch.object(bot, "now_utc", return_value=NOW).start()
        self.addCleanup(patch.stopall)
        patch.object(bot, "inspect_account", return_value={"status": "OK"}).start()
        self.sync = patch.object(bot, "sync_protection", side_effect=outcomes or [{"status": "active"}, {"status": "cancelled"}]).start()
        self.cancel = patch.object(bot, "cancel_protection").start()
        client = Mock()
        client.order_market_sell.return_value = FILL
        return client

    def test_close_sells_only_trend_position_and_preserves_user_pause(self):
        state = self.state()
        client = self.setup_exchange()
        untouched = copy.deepcopy((state["dca"], state["unmanaged_inventory"], state["positions"]["ETHUSDC"]))
        bot.process_manual_close(client, state, FILTERS)
        self.assertEqual(float(client.order_market_sell.call_args.kwargs["quantity"]), .001)
        self.assertEqual((state["dca"], state["unmanaged_inventory"], state["positions"]["ETHUSDC"]), untouched)
        self.assertTrue(state["entries_paused"])
        self.assertEqual(state["manual_close"]["status"], "completed")
        self.assertEqual(state["pair_cooldowns"]["BTCUSDC"], (NOW+timedelta(hours=1)).isoformat())
        self.assertEqual(state["pending_trade_logs"][0]["reason"], "MANUAL_CLOSE")
        bot.process_manual_close(client, state, FILTERS)
        self.assertEqual(client.order_market_sell.call_count, 1)
        self.assertEqual(len(state["pending_trade_logs"]), 1)

    def test_exchange_fill_during_cancel_does_not_sell_again(self):
        state = self.state()
        client = self.setup_exchange([{"status": "active"}, {"status": "filled", "exit_price": 11000, "quantity": .001, "reason": "TRAILING_STOP"}])
        bot.process_manual_close(client, state, FILTERS)
        client.order_market_sell.assert_not_called()
        self.assertEqual(state["manual_close"]["status"], "superseded")
        self.assertNotIn("pair_cooldowns", state)

    def test_cancel_timeout_recovers_after_restart(self):
        state = self.state()
        client = self.setup_exchange()
        persisted = []
        bot.db.save_state = lambda s: persisted.append(copy.deepcopy(s)) or True
        self.cancel.side_effect = TimeoutError()
        with self.assertRaises(TimeoutError):
            bot.process_manual_close(client, state, FILTERS)
        client.order_market_sell.assert_not_called()
        state = copy.deepcopy(persisted[-1])
        self.assertEqual(state["manual_close"]["status"], "cancelling")
        self.cancel.side_effect = None
        self.sync.side_effect = [{"status": "cancelled"}]
        bot.process_manual_close(client, state, FILTERS)
        self.assertEqual(client.order_market_sell.call_count, 1)
        self.assertEqual(self.cancel.call_count, 1)

    def test_ambiguous_sell_only_queries_original_id_after_restart(self):
        state = self.state()
        client = self.setup_exchange()
        persisted = []
        bot.db.save_state = lambda s: persisted.append(copy.deepcopy(s)) or True
        client.order_market_sell.side_effect = TimeoutError()
        with self.assertRaises(TimeoutError):
            bot.process_manual_close(client, state, FILTERS)
        state = copy.deepcopy(persisted[-1])
        intent = state["pending_order"]
        self.assertNotIn("pair_cooldowns", state)
        client.get_order.return_value = FILL
        self.clock.return_value = NOW+timedelta(minutes=10)
        bot.reconcile_pending_order(client, state)
        bot.process_manual_close(client, state, FILTERS)
        client.get_order.assert_called_once_with(symbol="BTCUSDC", origClientOrderId=intent["client_order_id"])
        self.assertEqual(client.order_market_sell.call_count, 1)
        self.assertEqual(state["pair_cooldowns"]["BTCUSDC"], (NOW+timedelta(minutes=70)).isoformat())

    def test_partial_or_unknown_sell_never_reports_success_or_retries(self):
        for response in [{**FILL, "status": "PARTIALLY_FILLED", "executedQty": ".0005"}, {**FILL, "executedQty": ".0005"}, None]:
            with self.subTest(response=response):
                state = self.state()
                client = self.setup_exchange()
                client.order_market_sell.side_effect = TimeoutError()
                with self.assertRaises(TimeoutError):
                    bot.process_manual_close(client, state, FILTERS)
                client.get_order.return_value = response
                if response is None:
                    client.get_order.side_effect = binance_error(-2013)
                with self.assertRaises(RuntimeError):
                    bot.reconcile_pending_order(client, state)
                self.assertIsNotNone(state["pending_order"])
                self.assertNotIn("pair_cooldowns", state)
                self.assertTrue(state["positions"]["BTCUSDC"]["in_position"])
                self.assertEqual(client.order_market_sell.call_count, 1)
                patch.stopall()

    def test_write_failure_before_cancel_never_cancels_protection(self):
        state = self.state()
        client = self.setup_exchange()
        bot.db.save_state = lambda _: False
        with self.assertRaises(RuntimeError):
            bot.process_manual_close(client, state, FILTERS)
        self.cancel.assert_not_called()
        client.order_market_sell.assert_not_called()

    def test_failed_completion_save_recovers_once(self):
        state = self.state()
        client = self.setup_exchange()
        persisted = []
        def save(s):
            if s["manual_close"]["status"] == "completed":
                return False
            persisted.append(copy.deepcopy(s))
            return True
        bot.db.save_state = save
        with self.assertRaises(RuntimeError):
            bot.process_manual_close(client, state, FILTERS)
        self.assertEqual(state["manual_close"]["status"], "selling")
        state = copy.deepcopy(persisted[-1])
        bot.db.save_state = lambda _: True
        client.get_order.return_value = FILL
        bot.reconcile_pending_order(client, state)
        self.assertEqual(len(state["pending_trade_logs"]), 1)
        self.assertEqual(client.order_market_sell.call_count, 1)

    def test_stale_request_cannot_close_replacement_position(self):
        state = self.state()
        client = self.setup_exchange()
        state["positions"]["BTCUSDC"]["entry_order_client_id"] = "entry-2"
        bot.process_manual_close(client, state, FILTERS)
        self.cancel.assert_not_called()
        client.order_market_sell.assert_not_called()
        self.assertEqual(state["manual_close"]["status"], "superseded")

    def test_unprocessed_request_expires(self):
        state = self.state()
        client = self.setup_exchange()
        state["manual_close"]["requested_at"] = (NOW-timedelta(minutes=6)).isoformat()
        bot.process_manual_close(client, state, FILTERS)
        self.assertEqual(state["manual_close"]["status"], "rejected")
        self.cancel.assert_not_called()

    def test_cooldown_is_durable_pair_scoped_and_does_not_resume_user_pause(self):
        state = self.state()
        client = self.setup_exchange()
        bot.process_manual_close(client, state, FILTERS)
        state = copy.deepcopy(state)  # persisted state after restart
        state["pending_trade_logs"] = []
        state["entries_paused"] = False
        self.assertEqual(entry_permission(state, NOW, symbol="BTCUSDC")[0], "PAIR_COOLDOWN")
        self.assertEqual(entry_permission(state, NOW, symbol="ETHUSDC")[0], "ENTRY_ALLOWED")
        later = NOW+timedelta(hours=1)
        state["reconciliation"]["checked_at"] = later.isoformat()
        self.assertEqual(entry_permission(state, later, symbol="BTCUSDC")[0], "ENTRY_ALLOWED")
        state["entries_paused"] = True
        self.assertEqual(entry_permission(state, later, symbol="BTCUSDC")[0], "ENTRIES_PAUSED")
        state["entries_paused"] = False
        state["daily_loss"] = 5
        self.assertEqual(entry_permission(state, later, symbol="BTCUSDC")[0], "DAILY_LOSS_LIMIT")

    def test_account_change_after_cancellation_blocks_sale_of_external_inventory(self):
        state = self.state()
        client = self.setup_exchange()
        with patch.object(bot, "inspect_account", side_effect=[
            {"status": "OK", "issues": []},
            {"status": "UNRESOLVED", "issues": [{"code": "INVENTORY_MISMATCH", "symbol": "BTCUSDC"}]},
        ]):
            with self.assertRaises(RuntimeError):
                bot.process_manual_close(client, state, FILTERS)
        client.order_market_sell.assert_not_called()
        self.assertEqual(state["manual_close"]["status"], "ready")
        self.assertNotIn("pair_cooldowns", state)

    def test_loss_limits_remain_in_force_after_manual_exit(self):
        state = self.state()
        state["consecutive_losses"] = 2
        client = self.setup_exchange()
        client.order_market_sell.return_value = {**FILL, "cummulativeQuoteQty": "9"}
        bot.process_manual_close(client, state, FILTERS)
        self.assertEqual(state["consecutive_losses"], 3)
        self.assertEqual(state["daily_loss"], 1)
        self.assertEqual(state["weekly_loss"], 1)
        state["pending_trade_logs"] = []
        state["entries_paused"] = False
        self.assertEqual(entry_permission(state, NOW, symbol="ETHUSDC")[0], "COOLDOWN_ACTIVE")

    def test_pending_protection_recovers_before_queued_manual_exit(self):
        state = self.state()
        state["pending_protection"] = {"listClientOrderId": "oco-1"}
        client = self.setup_exchange()
        sequence = []
        def recover(*args):
            sequence.append("recover")
            state["pending_protection"] = None
        with patch.object(bot, "reconcile_pending_protection", side_effect=recover), \
             patch.object(bot, "process_manual_close", side_effect=lambda *args: sequence.append("close")), \
             patch.object(bot, "sync_protection", return_value={"status": "active"}), \
             patch.object(bot, "inspect_account", return_value={"status": "OK", "available_quote": 100, "checked_at": NOW.isoformat()}):
            self.assertTrue(bot.reconcile_account(client, state, FILTERS))
        self.assertEqual(sequence, ["recover", "close"])

    def test_lost_completion_response_reloads_committed_fill_instead_of_recording_again(self):
        state = self.state()
        client = self.setup_exchange()
        committed = []
        def save(s):
            if s['manual_close']['status'] == 'completed':
                committed.append(copy.deepcopy(s))
                return False  # PATCH committed, but its response never arrived.
            return True
        bot.db.save_state = save
        with self.assertRaises(RuntimeError):
            bot.process_manual_close(client, state, FILTERS)
        self.assertIsNotNone(state['pending_order'])
        with patch.object(bot.db, 'load_state', return_value=committed[-1]):
            bot.refresh_entries_control(state)
        self.assertIsNone(state['pending_order'])
        self.assertFalse(state['positions']['BTCUSDC']['in_position'])
        self.assertEqual(state['manual_close']['status'], 'completed')
        self.assertEqual(len(state['pending_trade_logs']), 1)
        bot.process_manual_close(client, state, FILTERS)
        self.assertEqual(client.order_market_sell.call_count, 1)

    def test_exact_mainnet_btc_lot_sells_full_quantity(self):
        state = self.state()
        state['positions']['BTCUSDC']['position_qty'] = .00031
        client = self.setup_exchange()
        client.order_market_sell.return_value = {**FILL, 'executedQty': '0.00031000', 'cummulativeQuoteQty': '26.16'}
        bot.process_manual_close(client, state, {'BTCUSDC': (.00001,.01,5)})
        self.assertEqual(client.order_market_sell.call_args.kwargs['quantity'], '0.00031')
        self.assertEqual(state['pending_trade_logs'][0]['qty'], .00031)
        self.assertNotIn('strategy_residuals', state)

    def legacy_pending_state(self):
        state = self.state()
        state['positions']['BTCUSDC'].update(position_qty=.00031, entry_price=84501.14)
        state['manual_close']['status'] = 'selling'
        state['pending_order'] = {'side':'SELL', 'symbol':'BTCUSDC', 'quantity':.0003,
            'step_size':.00001, 'reason':'MANUAL_CLOSE', 'client_order_id':'known-sell',
            'manual_request_id':'request-1', 'created_at':NOW.isoformat()}
        return state

    def test_confirmed_legacy_fill_recovers_without_reselling_or_losing_remaining_lot(self):
        state = self.legacy_pending_state()
        client = self.setup_exchange()
        client.get_order.return_value = {'status':'FILLED','executedQty':'0.00030000',
            'cummulativeQuoteQty':'25.32237000', 'orderId':10435001521, 'updateTime':int(NOW.timestamp()*1000)}
        self.clock.return_value = NOW + timedelta(hours=4)
        bot.reconcile_pending_order(client, state)
        client.order_market_sell.assert_not_called()
        self.assertIsNone(state['pending_order'])
        self.assertFalse(state['positions']['BTCUSDC']['in_position'])
        self.assertEqual(state['strategy_residuals']['BTCUSDC']['quantity'], '0.00001000')
        self.assertAlmostEqual(float(state['strategy_residuals']['BTCUSDC']['cost_quote']), .8450114)
        self.assertEqual(state['pending_trade_logs'][0]['qty'], .0003)
        self.assertAlmostEqual(state['pending_trade_logs'][0]['pnl'], -.027972)
        self.assertEqual(state['pending_trade_logs'][0]['exit_time'], NOW.isoformat())
        self.assertEqual(state['manual_close']['residual_quantity'], .00001)
        self.assertEqual(state['manual_close']['status'], 'completed')
        persisted = copy.deepcopy(state)
        bot.reconcile_pending_order(client, persisted)
        bot.process_manual_close(client, persisted, FILTERS)
        self.assertEqual(len(persisted['pending_trade_logs']),1)
        self.assertEqual(persisted['strategy_residuals'],state['strategy_residuals'])
        self.assertEqual(client.get_order.call_count,1)
        client.order_market_sell.assert_not_called()

    def test_larger_mismatch_is_not_disguised_as_residual(self):
        state = self.legacy_pending_state()
        state['positions']['BTCUSDC']['position_qty'] = .00032
        client = self.setup_exchange()
        client.get_order.return_value = {'status':'FILLED','executedQty':'.0003','cummulativeQuoteQty':'25.32237'}
        with self.assertRaises(RuntimeError):
            bot.reconcile_pending_order(client, state)
        self.assertIsNotNone(state['pending_order'])
        self.assertNotIn('strategy_residuals',state)
        client.order_market_sell.assert_not_called()

    def test_failed_residual_write_rolls_back_and_recovers_exactly_once(self):
        state = self.legacy_pending_state()
        client = self.setup_exchange()
        client.get_order.return_value = {'status':'FILLED','executedQty':'.0003','cummulativeQuoteQty':'25.32237'}
        bot.db.save_state = lambda _: False
        with self.assertRaises(RuntimeError):
            bot.reconcile_pending_order(client, state)
        self.assertNotIn('strategy_residuals',state)
        self.assertIsNotNone(state['pending_order'])
        bot.db.save_state = lambda _: True
        bot.reconcile_pending_order(client, state)
        self.assertEqual(float(state['strategy_residuals']['BTCUSDC']['quantity']),.00001)
        self.assertEqual(len(state['pending_trade_logs']),1)
