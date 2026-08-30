import unittest
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from dca import dca_due, run_weekly_dca


SUNDAY = datetime(2026, 8, 30, 6, 0, tzinfo=timezone.utc)


class FakeClient:
    def __init__(self):
        self.orders = []

    def order_market_buy(self, **request):
        self.orders.append(request)
        return {"status": "FILLED", "orderId": len(self.orders), "executedQty": "0.00005", "cummulativeQuoteQty": request["quoteOrderQty"]}

    def get_order(self, **request):
        return {"status": "FILLED", "orderId": 99, "executedQty": "0.00005", "cummulativeQuoteQty": "5.00"}


class DcaTests(unittest.TestCase):
    def test_due_sunday_at_eight_prague_only_once(self):
        state = {"dca": {}}
        self.assertTrue(dca_due(state, SUNDAY))
        state["dca"]["completed_week"] = "2026-W35"
        self.assertFalse(dca_due(state, SUNDAY))

    def test_buys_each_asset_once_and_marks_week_complete(self):
        state = {}
        client = FakeClient()
        saves = []
        results = run_weekly_dca(client, state, ["BTCUSDC", "ETHUSDC", "SOLUSDC"], 5, {
            "BTCUSDC": 5, "ETHUSDC": 5, "SOLUSDC": 5,
        }, lambda current: saves.append(current.copy()) or True, lambda _: 20, SUNDAY)
        self.assertEqual(len(client.orders), 3)
        self.assertEqual(len(results), 3)
        self.assertEqual(state["dca"]["completed_week"], "2026-W35")
        run_weekly_dca(client, state, ["BTCUSDC"], 5, {"BTCUSDC": 5}, lambda _: True, lambda _: 20, SUNDAY)
        self.assertEqual(len(client.orders), 3)

    def test_skips_order_below_symbol_minimum(self):
        state = {}
        client = FakeClient()
        results = run_weekly_dca(client, state, ["BTCUSDC"], 5, {"BTCUSDC": 10}, lambda _: True, lambda _: 20, SUNDAY)
        self.assertEqual(client.orders, [])
        self.assertEqual(results[0]["status"], "skipped")

    def test_recovers_saved_pending_order_without_new_buy(self):
        state = {"dca": {"pending": {"week": "2026-W35", "symbol": "BTCUSDC", "client_order_id": "stable", "amount": 5}}}
        client = FakeClient()
        results = run_weekly_dca(client, state, ["BTCUSDC"], 5, {"BTCUSDC": 5}, lambda _: True, lambda _: 20, SUNDAY)
        self.assertEqual(client.orders, [])
        self.assertEqual(results[0]["status"], "filled")


if __name__ == "__main__":
    unittest.main()
