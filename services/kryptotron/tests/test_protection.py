import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from protection import build_protection_oco, store_protection, trailing_delta_filter


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


if __name__ == "__main__":
    unittest.main()
