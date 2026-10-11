import copy
import unittest
from datetime import datetime, timezone
from unittest.mock import patch
from dca import asset_plan, due_period, run_scheduled_dca
from test_dca import FakeClient

SYMBOLS = ["BTCUSDC", "ETHUSDC", "SOLUSDC"]
NOVEMBER = datetime(2026, 11, 1, 7, tzinfo=timezone.utc)  # Sunday, 08:00 Prague


class DcaPlanTests(unittest.TestCase):
    def state(self):
        return {"dca": {"enabled": True, "amount": 5, "plans": {
            symbol: {"amount": amount, "frequency": frequency}
            for symbol, amount, frequency in zip(SYMBOLS, [5, 10, 20], ["daily", "weekly", "monthly"])}}}

    def run_plan(self, state, client, now=NOVEMBER, **kwargs):
        return run_scheduled_dca(client, state, SYMBOLS, dict.fromkeys(SYMBOLS, 5),
            kwargs.pop("save_state", lambda _: True), kwargs.pop("get_balance", lambda _: 100), now, **kwargs)

    def test_shared_frequency_drives_all_three_assets_with_different_amounts(self):
        for frequency in ["daily", "weekly", "monthly"]:
            state, client = self.state(), FakeClient()
            state["dca"]["frequency"] = frequency
            self.assertTrue(all(asset_plan(state["dca"], symbol)["frequency"] == frequency for symbol in SYMBOLS))
            self.run_plan(state, client)
            self.assertEqual([o["quoteOrderQty"] for o in client.orders], ["5.00", "10.00", "20.00"])
            self.run_plan(state, client)
            self.assertEqual(len(client.orders), 3)
            self.run_plan(state, client, datetime(2026, 11, 2, 7, tzinfo=timezone.utc))
            self.assertEqual(len(client.orders), 6 if frequency == "daily" else 3)

    def test_independent_amounts_and_frequencies_once_per_period(self):
        state, client = self.state(), FakeClient()
        self.run_plan(state, client)
        self.assertEqual([o["quoteOrderQty"] for o in client.orders], ["5.00", "10.00", "20.00"])
        self.run_plan(state, client)
        self.assertEqual(len(client.orders), 3)
        self.run_plan(state, client, datetime(2026, 11, 2, 7, tzinfo=timezone.utc))
        self.assertEqual(len(client.orders), 4)
        self.assertEqual(client.orders[-1]["symbol"], "BTCUSDC")
        self.assertTrue(all(len(o["newClientOrderId"]) <= 36 for o in client.orders))

    def test_schedule_is_prague_time_across_dst_and_month_boundaries(self):
        state = self.state()["dca"]
        daily, weekly, monthly = [asset_plan(state, s) for s in SYMBOLS]
        for at, expected in [("2026-03-29T05:59:00+00:00", False), ("2026-03-29T06:00:00+00:00", True),
                             ("2026-10-25T06:59:00+00:00", False), ("2026-10-25T07:00:00+00:00", True)]:
            self.assertEqual(bool(due_period(state, "BTCUSDC", daily, datetime.fromisoformat(at))), expected)
            self.assertEqual(bool(due_period(state, "ETHUSDC", weekly, datetime.fromisoformat(at))), expected)
        self.assertIsNone(due_period(state, "SOLUSDC", monthly, datetime(2026, 10, 31, 10, tzinfo=timezone.utc)))
        self.assertEqual(due_period(state, "SOLUSDC", monthly, NOVEMBER), "2026-11")
        self.assertIsNone(due_period(state, "SOLUSDC", monthly, datetime(2026, 11, 2, 10, tzinfo=timezone.utc)))

    def test_edits_start_at_future_slot_never_immediate_or_catch_up(self):
        dca = self.state()["dca"]
        plan = {"amount": 10, "frequency": "daily", "configured_at": "2026-11-01T07:00:00+00:00"}
        self.assertIsNone(due_period(dca, "BTCUSDC", plan, NOVEMBER))
        self.assertIsNone(due_period(dca, "BTCUSDC", plan, datetime(2026, 11, 1, 16, tzinfo=timezone.utc)))
        self.assertEqual(due_period(dca, "BTCUSDC", plan, datetime(2026, 11, 2, 7, tzinfo=timezone.utc)), "2026-11-02")

    def test_completion_survives_trimmed_history_restart_and_skips(self):
        state, client = self.state(), FakeClient()
        self.run_plan(state, client)
        state["dca"]["purchases"] = []
        self.run_plan(copy.deepcopy(state), client)
        self.assertEqual(len(client.orders), 3)
        state, client = self.state(), FakeClient()
        self.run_plan(state, client, get_balance=lambda _: 0)
        self.run_plan(state, client)
        self.assertEqual(client.orders, [])

    def test_legacy_weekly_checkpoints_and_amounts_are_preserved(self):
        for dca in [{"completed_week": "2026-W44"}, {"purchases": [{"symbol": "BTCUSDC", "week": "2026-W44"}]}]:
            dca.update(enabled=True, amount=200)
            self.assertEqual(asset_plan(dca, "BTCUSDC")["amount"], 200)
            self.assertIsNone(due_period(dca, "BTCUSDC", asset_plan(dca, "BTCUSDC"), NOVEMBER))

    def test_lost_response_recovers_pending_without_resubmission(self):
        state, client = self.state(), FakeClient()
        with patch.object(client, "order_market_buy", side_effect=TimeoutError):
            with self.assertRaises(TimeoutError): self.run_plan(state, client)
        self.assertIsNotNone(state["dca"]["pending"])
        self.run_plan(state, client)
        self.assertEqual([o["symbol"] for o in client.orders], ["ETHUSDC", "SOLUSDC"])
        self.assertEqual(state["dca"]["completed_periods"]["BTCUSDC"]["daily"], "2026-11-01")

    def test_pause_or_edit_before_order_prevents_old_plan_and_does_not_consume_slot(self):
        state, client = self.state(), FakeClient()
        def edit(symbol, plan):
            state["dca"]["plans"][symbol]["amount"] = 100
            return True
        self.run_plan(state, client, before_order=edit)
        self.assertEqual(client.orders, [])
        self.assertNotIn("completed_periods", state["dca"])
        self.run_plan(state, client, before_order=lambda *_: False)
        self.assertEqual(client.orders, [])

    def test_manual_test_uses_per_asset_amounts_without_consuming_calendar_slots(self):
        state, client = self.state(), FakeClient()
        self.run_plan(state, client, run_key="test-plan")
        self.assertEqual(len(client.orders), 3)
        self.assertNotIn("completed_periods", state["dca"])
        self.run_plan(state, client, run_key="test-plan")
        self.assertEqual(len(client.orders), 3)
        self.run_plan(state, client)
        self.assertEqual(len(client.orders), 6)

    def test_invalid_plan_and_failed_intent_persistence_do_not_submit(self):
        for invalid in [{"amount": 7, "frequency": "daily"}, {"amount": 5, "frequency": "hourly"}]:
            state, client = self.state(), FakeClient()
            state["dca"]["plans"]["BTCUSDC"] = invalid
            with self.assertRaises(ValueError): self.run_plan(state, client)
            self.assertEqual(client.orders, [])
        state, client = self.state(), FakeClient()
        with self.assertRaises(RuntimeError): self.run_plan(state, client, save_state=lambda _: False)
        self.assertEqual(client.orders, [])
