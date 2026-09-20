import copy
import json
import math
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "research"))
from data import closed_klines, validate_bars
import holdout as H
import strategies as S


def dataset(n=1200):
    bars = []
    for i in range(n):
        price = 100 + i * .03 + 12 * math.sin(i / 20)
        bars.append(dict(t=i * H.STEP, open=price, high=price + 2, low=price - 2, close=price))
    return {s: copy.deepcopy(bars) for s in H.SYMBOLS}


class ResearchTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.bars = dataset()
        cls.lock = H.make_lock(cls.bars, 0, 610 * H.STEP, 1150 * H.STEP,
                              now_ms=600 * H.STEP + 1, n_seeds=2)

    def test_cached_open_candle_stays_excluded(self):
        rows = [[0, '1', '2', '.5', '1', '0', 99], [100, '1', '2', '.5', '1', '0', 199]]
        self.assertEqual(closed_klines(rows, 150), rows[:1])

    def test_data_gate_rejects_gaps_duplicates_and_nonfinite_prices(self):
        bars = dataset(250)[H.SYMBOLS[0]]
        del bars[50]
        bars[90]["t"] = bars[89]["t"]
        bars[120]["high"] = float("inf")
        self.assertEqual(len(validate_bars("BTCUSDC", "4h", bars)), 3)

    def test_cannot_register_already_seen_period(self):
        with self.assertRaisesRegex(ValueError, "future"):
            H.make_lock(self.bars, 0, 500 * H.STEP, 1100 * H.STEP, now_ms=600 * H.STEP)

    def test_cannot_score_before_fixed_end(self):
        with self.assertRaisesRegex(ValueError, "early scoring"):
            H.evaluate(self.lock, self.bars, now_ms=1149 * H.STEP)

    def test_rejects_changed_training_snapshot(self):
        bars = copy.deepcopy(self.bars)
        bars[H.SYMBOLS[0]][300]["close"] += 1
        with self.assertRaisesRegex(ValueError, "snapshot changed"):
            H.evaluate(self.lock, bars, now_ms=1200 * H.STEP)

    def test_rejects_changed_protocol(self):
        lock = copy.deepcopy(self.lock)
        lock["params"]["ema_fast"] = 20
        with self.assertRaisesRegex(ValueError, "Protocol changed"):
            H.evaluate(lock, self.bars, now_ms=1200 * H.STEP)

    def test_requires_complete_holdout(self):
        bars = {s: b[:1100] for s, b in self.bars.items()}
        with self.assertRaisesRegex(ValueError, "full holdout"):
            H.evaluate(self.lock, bars, now_ms=1200 * H.STEP)

    def test_missing_test_candle_is_rejected(self):
        bars = copy.deepcopy(self.bars)
        del bars[H.SYMBOLS[0]][700]
        with self.assertRaises(ValueError):
            H.evaluate(self.lock, bars, now_ms=1200 * H.STEP)

    def test_warmup_never_trades_before_boundary(self):
        start = 610 * H.STEP
        calls = []
        def entry(fast, slow, i):
            calls.append(i)
            return False
        curve, trades = S.simulate_trend_symbol(self.bars[H.SYMBOLS[0]], entry_fn=entry,
                                                trade_start_ms=start)
        self.assertEqual(curve[0], (start, 1.0))
        self.assertGreaterEqual(min(calls), 610)
        self.assertEqual(trades, [])

    def test_results_ignore_data_after_test_end(self):
        first = H.evaluate(self.lock, self.bars, now_ms=1200 * H.STEP)
        changed = copy.deepcopy(self.bars)
        for bars in changed.values():
            for b in bars[1150:]:
                b["close"] = 999999
        second = H.evaluate(self.lock, changed, now_ms=1200 * H.STEP)
        self.assertEqual(first, second)
        self.assertFalse(first["promotion_allowed"])
        self.assertEqual(len(first["random_runs"]), 2)

    def test_lock_does_not_depend_on_future_prices(self):
        changed = copy.deepcopy(self.bars)
        for bars in changed.values():
            for b in bars[600:]:
                b["close"] = 999999
        second = H.make_lock(changed, 0, 610 * H.STEP, 1150 * H.STEP,
                             now_ms=600 * H.STEP + 1, n_seeds=2)
        self.assertEqual(self.lock, second)

    def test_lock_is_never_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "lock.json"
            H.write_new(path, self.lock)
            with self.assertRaises(FileExistsError):
                H.write_new(path, {"changed": True})
            self.assertEqual(json.loads(path.read_text()), self.lock)
