import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from strategy import get_cross_data


def candle(price):
    return [0, str(price), str(price + 1), str(price - 1), str(price)]


class FakeClient:
    def __init__(self, klines):
        self.klines = klines

    def get_klines(self, **_kwargs):
        return self.klines


class StrategyDataValidationTests(unittest.TestCase):
    def test_rejects_insufficient_closed_candles_with_clear_error(self):
        client = FakeClient([candle(100), candle(101)])

        with self.assertRaisesRegex(RuntimeError, r"nedostatek tržních dat \(1/200"):
            get_cross_data(client, "ETHUSDC")

    def test_rejects_malformed_candle_with_clear_error(self):
        client = FakeClient([candle(100) for _ in range(199)] + [[0], candle(101)])

        with self.assertRaisesRegex(RuntimeError, "neúplná tržní data"):
            get_cross_data(client, "ETHUSDC")

    def test_returns_cross_data_when_history_is_complete(self):
        client = FakeClient([candle(100 + index) for index in range(201)])

        result = get_cross_data(client, "ETHUSDC")

        self.assertEqual(result["close"], 299.0)
        self.assertTrue(result["bull"])
        self.assertIn("golden_cross", result)

    def test_bull_regime_does_not_require_a_new_cross(self):
        result = get_cross_data(FakeClient([candle(100 + i) for i in range(210)]), "BTCUSDC")
        self.assertTrue(result["bull"])
        self.assertFalse(result["golden_cross"])

    def test_unclosed_candle_cannot_change_signal(self):
        history = [candle(100 + i) for i in range(209)]
        low = get_cross_data(FakeClient(history + [candle(1)]), "BTCUSDC")
        high = get_cross_data(FakeClient(history + [candle(1000000)]), "BTCUSDC")
        self.assertEqual(low, high)


if __name__ == "__main__":
    unittest.main()
