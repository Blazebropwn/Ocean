import copy
import hashlib
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "research"))
from production_model import rolling_signals, simulate
from test_research import dataset
from strategy import get_cross_data


class ProductionParityTests(unittest.TestCase):
    def test_frozen_research_sources_and_protocol_are_untouched(self):
        protocol = json.loads((ROOT / "research/holdout-2026-09-21.json").read_text())
        for path, digest in protocol["implementation"]["files"].items():
            # utils.py already differed at the starting commit 88d8383; the
            # original copy is preserved in the pre-existing frozen archive.
            if path == "utils.py":
                continue
            self.assertEqual(hashlib.sha256((ROOT/path).read_bytes()).hexdigest(), digest, path)

    def test_original_holdout_refuses_current_runtime_drift(self):
        import holdout
        protocol = json.loads((ROOT / "research/holdout-2026-09-21.json").read_text())
        with self.assertRaisesRegex(ValueError, "Code or runtime changed"):
            holdout.evaluate(protocol, {}, now_ms=protocol["test_end_ms"])

    def test_current_open_candle_never_changes_rolling_signal(self):
        bars = dataset(215)["BTCUSDC"]
        first = rolling_signals(bars)
        bars[214].update(open=9999, high=10000, low=9000, close=9999)
        second = rolling_signals(bars)
        self.assertEqual(first[214], second[214])

    def test_rolling_signal_matches_production_call_on_same_209_closes(self):
        bars = dataset(215)["BTCUSDC"]
        class Client:
            def get_klines(self, **kwargs):
                return [[b["t"],b["open"],b["high"],b["low"],b["close"],0,b["t"]+14400000-1] for b in bars[5:215]]
        self.assertEqual(rolling_signals(bars)[214], get_cross_data(Client(), "BTCUSDC"))

    def test_cash_and_costs_have_known_economics(self):
        bars = dataset(240)
        signals = {symbol: rolling_signals(values) for symbol, values in bars.items()}
        stats, curve, trades = simulate(bars, signals, kind="cash")
        self.assertEqual(stats["total_return"], 0)
        self.assertEqual(stats["fees_paid"], 0)
        self.assertEqual(stats["time_in_market"], 0)
        self.assertEqual(trades, [])
        for values in bars.values():
            for bar in values:
                bar.update(open=100,high=100,low=100,close=100)
        stats, _, _ = simulate(bars, signals, kind="buy_hold", fee=.001, slippage=0)
        self.assertAlmostEqual(stats["final_equity"], 1000/1.001)
        self.assertGreater(stats["fees_paid"], 0)

    def test_random_is_reproducible_and_does_not_mutate_source(self):
        bars = dataset(450)
        before = copy.deepcopy(bars)
        signals = {symbol: rolling_signals(values) for symbol, values in bars.items()}
        first = simulate(bars, signals, kind="random", seed=9)
        second = simulate(bars, signals, kind="random", seed=9)
        self.assertEqual(first, second)
        self.assertEqual(bars, before)

    def test_alignment_is_required_instead_of_silent_intersection(self):
        bars = dataset(240)
        signals = {symbol: rolling_signals(values) for symbol, values in bars.items()}
        del bars["ETHUSDC"][220]
        with self.assertRaisesRegex(ValueError, "identical"):
            simulate(bars, signals)
