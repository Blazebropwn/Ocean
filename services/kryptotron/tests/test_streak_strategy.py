import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from streak_strategy import paper_close_result, size_paper_setup, trend_pullback_signal


class StreakStrategyTests(unittest.TestCase):
    def test_rejects_market_without_uptrend(self):
        closes = list(reversed(range(100, 160)))
        signal, reason = trend_pullback_signal(closes, [value - 1 for value in closes])
        self.assertIsNone(signal)
        self.assertEqual(reason, "NO_UPTREND")

    def test_sizes_position_by_risk_but_caps_available_capital(self):
        setup, reason = size_paper_setup("BTCUSDC", 100, 99, 100, risk_usdc=1)
        self.assertEqual(reason, "READY")
        self.assertEqual(setup.quote_size, 50)
        self.assertLess(setup.risk_usdc, 1)

    def test_target_is_one_net_r_after_costs(self):
        setup, _ = size_paper_setup("BTCUSDC", 100, 99, 1000, risk_usdc=1)
        result = paper_close_result(setup, setup.target_price)
        self.assertAlmostEqual(result["net_pnl"], 1, places=6)

    def test_rejects_position_below_exchange_minimum(self):
        setup, reason = size_paper_setup("SOLUSDC", 100, 98, 5, risk_usdc=1, min_notional=5)
        self.assertIsNone(setup)
        self.assertEqual(reason, "BELOW_MIN_NOTIONAL")


if __name__ == "__main__":
    unittest.main()
