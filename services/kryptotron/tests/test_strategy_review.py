"""Research guardrails and known economics, independent of real market outcomes."""
import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "research"))
from strategy_review import STEP, STEP15, entry_signal, load_data, simulate
from production_model import rolling_signals

BASE = 1679702400000  # 2023-03-25 00:00 UTC


def market(count=220):
    coarse, fine = {}, {}
    for symbol in ("BTCUSDC", "ETHUSDC"):
        coarse[symbol], fine[symbol] = [], []
        for i in range(count):
            bar = {"t": BASE + i * STEP, "open": 100., "high": 101., "low": 99., "close": 100.}
            coarse[symbol].append(bar)
            fine[symbol].extend({**bar, "t": bar["t"] + j * STEP15} for j in range(16))
    return coarse, fine


def forced_bull(coarse):
    return {symbol: {i: {"bull": True, "golden_cross": False, "death_cross": False,
        "close": 100., "ema_fast": 99., "ema_slow": 98.} for i in range(209, len(values))}
        for symbol, values in coarse.items()}


class CandidateRulesTests(unittest.TestCase):
    def test_predeclared_rules_distinguish_reentry_and_trend_confirmation(self):
        current = {"bull": True, "golden_cross": False, "close": 101, "ema_fast": 100}
        self.assertTrue(entry_signal("regime", current))
        self.assertFalse(entry_signal("fresh_cross", current))
        self.assertTrue(entry_signal("above_fast", current))
        self.assertFalse(entry_signal("rising_fast", current, {"ema_fast": 102}))
        self.assertTrue(entry_signal("rising_fast", current, {"ema_fast": 99}))
        self.assertFalse(entry_signal("rising_fast", current))
        self.assertFalse(entry_signal("above_fast", {**current, "close": 99}))
        for variant in ("regime", "fresh_cross", "above_fast", "rising_fast"):
            self.assertFalse(entry_signal(variant, {**current, "bull": False, "golden_cross": True}))

    def test_fresh_cross_cannot_reenter_a_mature_bull_regime(self):
        coarse, fine = market()
        signals = forced_bull(coarse)
        start, end = BASE + 209 * STEP, BASE + 210 * STEP
        baseline, _ = simulate(coarse, fine, signals, start_ms=start, end_ms=end)
        candidate, _ = simulate(coarse, fine, signals, variant="fresh_cross", start_ms=start, end_ms=end)
        self.assertGreater(baseline["order_count"], 0)
        self.assertEqual(candidate["order_count"], 0)


class ResearchEconomicsTests(unittest.TestCase):
    def test_passive_costs_and_cash_have_known_economics(self):
        coarse, fine = market()
        signals = forced_bull(coarse)
        kwargs = {"start_ms": BASE + 209 * STEP, "end_ms": BASE + 210 * STEP}
        cash, trades = simulate(coarse, fine, signals, variant="cash", **kwargs)
        self.assertEqual(cash["final_equity"], 100)
        self.assertEqual(trades, [])
        passive, _ = simulate(coarse, fine, signals, variant="buy_hold", fee=.001, slippage=.0005, **kwargs)
        self.assertAlmostEqual(passive["final_equity"], 100 / 1.001 / 1.0005)
        self.assertEqual(passive["order_count"], 2)

    def test_future_prices_do_not_change_an_earlier_evaluation(self):
        coarse, fine = market()
        signals = {symbol: rolling_signals(bars) for symbol, bars in coarse.items()}
        start, end = BASE + 209 * STEP, BASE + 210 * STEP
        before = simulate(coarse, fine, signals, start_ms=start, end_ms=end)
        for collection in (coarse, fine):
            for bars in collection.values():
                for bar in bars:
                    if bar["t"] >= end:
                        bar.update(open=9999, high=10000, low=9000, close=9999)
        changed_signals = {symbol: rolling_signals(bars) for symbol, bars in coarse.items()}
        self.assertEqual(before, simulate(coarse, fine, changed_signals, start_ms=start, end_ms=end))

    def test_fine_ohlc_paths_can_still_disagree_and_sources_are_unchanged(self):
        coarse, fine = market()
        start = BASE + 209 * STEP
        for bars in fine.values():
            next(bar for bar in bars if bar["t"] == start).update(high=104., low=99., close=103.)
        saved = copy.deepcopy((coarse, fine))
        signals = forced_bull(coarse)
        low, _ = simulate(coarse, fine, signals, start_ms=start, end_ms=start + STEP15, fee=0, slippage=0)
        high, _ = simulate(coarse, fine, signals, start_ms=start, end_ms=start + STEP15, fee=0, slippage=0, path="high_first")
        self.assertEqual(low["closed_trade_count"], 0)
        self.assertEqual(high["closed_trade_count"], 2)
        self.assertEqual((coarse, fine), saved)


class DataGateTests(unittest.TestCase):
    def write_cache(self, directory, mutate=None):
        coarse, fine = market()
        for interval, step, collection in (("4h", STEP, coarse), ("15m", STEP15, fine)):
            for symbol, bars in collection.items():
                rows = [[b["t"], b["open"], b["high"], b["low"], b["close"], 0, b["t"] + step - 1] for b in bars]
                if mutate:
                    mutate(symbol, interval, rows)
                # Invalid data from the prohibited future must be sliced out before validation.
                rows.append([BASE + 220 * STEP, "bad", "bad", "bad", "bad", 0, BASE + 221 * STEP])
                (directory / f"{symbol}_{interval}.json").write_text(json.dumps(rows))
        return {"train_start_ms": BASE, "train_end_ms": BASE + 220 * STEP,
                "test_start_ms": BASE + 221 * STEP}

    def test_loader_excludes_future_and_checks_fine_coarse_alignment(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            protocol = self.write_cache(directory)
            coarse, fine, _ = load_data(directory, protocol, start=BASE)
            self.assertEqual(len(coarse["BTCUSDC"]), 220)
            self.assertEqual(len(fine["BTCUSDC"]), 220 * 16)

    def test_aggregation_mismatch_and_missing_execution_candle_fail_closed(self):
        def mismatch(symbol, interval, rows):
            if symbol == "BTCUSDC" and interval == "15m":
                rows[100][2] = 102
        def gap(symbol, interval, rows):
            if symbol == "BTCUSDC" and interval == "15m":
                del rows[100]
        for mutate in (mismatch, gap):
            with self.subTest(mutate=mutate.__name__), tempfile.TemporaryDirectory() as temp:
                directory = Path(temp)
                protocol = self.write_cache(directory, mutate)
                with self.assertRaises(ValueError):
                    load_data(directory, protocol, start=BASE)


if __name__ == "__main__":
    unittest.main()
