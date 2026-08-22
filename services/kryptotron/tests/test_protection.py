import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from protection import (
    build_protection_oco,
    cancel_protection,
    clear_protection,
    protection_outcome,
    query_protection,
    store_protection,
    trailing_delta_filter,
)


class FakeClient:
    def __init__(self, orders=None):
        self.orders = orders or {}
        self.queries = []
        self.cancellations = []

    def get_order(self, **params):
        return self.orders[params["orderId"]]

    def v3_get_order_list(self, **params):
        self.queries.append(params)
        return {"listOrderStatus": "EXECUTING", "orders": []}

    def v3_delete_order_list(self, **params):
        self.cancellations.append(params)
        return {"listOrderStatus": "ALL_DONE"}


class ProtectionTests(unittest.TestCase):
    def test_builds_emergency_stop_and_delayed_trailing_pair(self):
        request = build_protection_oco("BTCUSDC", 0.001, 100_000, 0.01, 10, 3, 1.5, 10, 2000)
        self.assertEqual(request["side"], "SELL")
        self.assertEqual(request["aboveType"], "TAKE_PROFIT")
        self.assertEqual(request["aboveStopPrice"], "103000.00")
        self.assertEqual(request["aboveTrailingDelta"], 150)
        self.assertEqual(request["belowType"], "STOP_LOSS")
        self.assertEqual(request["belowStopPrice"], "90000.00")

    def test_rejects_trailing_delta_outside_symbol_filter(self):
        with self.assertRaisesRegex(ValueError, "TRAILING_DELTA"):
            build_protection_oco("BTCUSDC", 0.001, 100_000, 0.01, 10, 3, 1.5, 200, 1000)

    def test_reads_sell_trailing_filter(self):
        info = {"filters": [{"filterType": "TRAILING_DELTA", "minTrailingBelowDelta": 10, "maxTrailingBelowDelta": 2000}]}
        self.assertEqual(trailing_delta_filter(info), (10, 2000))

    def test_stores_exchange_order_list_identity(self):
        position = {}
        request = build_protection_oco("ETHUSDC", 0.01, 2500, 0.01, 10, 3, 1.5, 10, 2000)
        store_protection(position, {"orderListId": 77}, request)
        self.assertEqual(position["protection_order_list_id"], 77)
        self.assertEqual(position["protection_status"], "ACTIVE")
        self.assertEqual(position["position_qty"], 0.01)

    def test_reads_filled_trailing_leg_and_execution_price(self):
        client = FakeClient({
            10: {
                "status": "FILLED",
                "clientOrderId": "ocean-trail-abc",
                "executedQty": "0.002",
                "cummulativeQuoteQty": "210",
            },
            11: {"status": "CANCELED", "clientOrderId": "ocean-stop-abc"},
        })
        result = protection_outcome(
            client,
            "BTCUSDC",
            {"listOrderStatus": "ALL_DONE", "orders": [{"orderId": 10}, {"orderId": 11}]},
        )
        self.assertEqual(result["status"], "filled")
        self.assertEqual(result["reason"], "TRAILING_STOP")
        self.assertEqual(result["exit_price"], 105000.0)

    def test_cancelled_list_is_safe_only_when_no_leg_filled(self):
        client = FakeClient({
            10: {"status": "CANCELED", "clientOrderId": "ocean-trail-abc"},
            11: {"status": "CANCELED", "clientOrderId": "ocean-stop-abc"},
        })
        result = protection_outcome(
            client,
            "BTCUSDC",
            {"listOrderStatus": "ALL_DONE", "orders": [{"orderId": 10}, {"orderId": 11}]},
        )
        self.assertEqual(result["status"], "cancelled")

    def test_query_and_cancel_use_persisted_client_identity(self):
        client = FakeClient()
        query_protection(client, "BTCUSDC", "ocean-protect-btcusdc-abc")
        cancel_protection(client, "BTCUSDC", "ocean-protect-btcusdc-abc")
        self.assertEqual(client.queries, [{"origClientOrderId": "ocean-protect-btcusdc-abc"}])
        self.assertEqual(client.cancellations, [{
            "symbol": "BTCUSDC",
            "listClientOrderId": "ocean-protect-btcusdc-abc",
        }])

    def test_clears_all_exchange_protection_identity(self):
        position = {
            "protection_order_list_id": 77,
            "protection_client_id": "ocean-protect",
            "protection_status": "ACTIVE",
        }
        clear_protection(position)
        self.assertIsNone(position["protection_order_list_id"])
        self.assertIsNone(position["protection_client_id"])
        self.assertIsNone(position["protection_status"])


if __name__ == "__main__":
    unittest.main()
