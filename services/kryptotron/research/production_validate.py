"""Read-only pre-holdout benchmark arena. Never scores or modifies the holdout."""
import argparse
import hashlib
import json
from pathlib import Path
import statistics

from data import to_bars, validate_bars
from production_model import rolling_signals, simulate, STEP
from config import settings

ROOT = Path(__file__).resolve().parent


def run(cache, lock, *, capital=1000.0, seeds=40):
    protocol = json.loads(lock.read_text())
    end = min(protocol["train_end_ms"], protocol["test_start_ms"])
    bars = {}
    for symbol in ("BTCUSDC", "ETHUSDC"):
        source = cache / f"{symbol}_4h.json"
        # Slice before computing indicators, calibration or any performance metric.
        rows = [row for row in json.loads(source.read_text())
                if protocol["train_start_ms"] <= row[0] and row[0]+STEP <= end]
        bars[symbol] = to_bars(rows)
        errors = validate_bars(symbol, "4h", bars[symbol])
        if errors:
            raise ValueError("; ".join(errors))
    signals = {s: rolling_signals(values) for s, values in bars.items()}
    scenarios = {name: simulate(bars, signals, kind=name, capital=capital)[0]
                 for name in ("regime", "buy_hold", "dca", "cash")}
    scenarios["regime_high_first"] = simulate(bars, signals, capital=capital, path="high_first")[0]
    scenarios["regime_double_cost"] = simulate(bars, signals, capital=capital, fee=.002, slippage=.001)[0]
    random_runs = [simulate(bars, signals, kind="random", capital=capital, seed=seed,
                            random_probability=protocol["random_probability"])[0] for seed in range(1, seeds+1)]
    return {"evaluation": "exploratory_pre_holdout", "production_parity": "partial_explicit_execution_approximations",
            "promotion_allowed": False, "end_exclusive_ms": end,
            "data_hash": hashlib.sha256(json.dumps(bars, sort_keys=True).encode()).hexdigest(),
            "source_hashes": {str(path.relative_to(ROOT.parent)): hashlib.sha256(path.read_bytes()).hexdigest()
                              for path in [ROOT/"production_model.py", ROOT/"production_validate.py", ROOT.parent/"risk.py",
                                           ROOT.parent/"strategy.py", ROOT.parent/"config/settings.py", ROOT.parent/"dca.py", ROOT.parent/"utils.py"]},
            "configuration": {"initial_capital": capital, "fee_rate": .001, "slippage_rate": .0005,
                              "dca_amount_per_symbol": settings.DCA_AMOUNT_USDC,
                              "position_pct": settings.POSITION_PCT, "max_order_quote": settings.MAX_POSITION_USDT},
            "random_probability": protocol["random_probability"], "random_seeds": list(range(1, seeds+1)),
            "scenarios": scenarios, "random_runs": random_runs,
            "random_median_sharpe": statistics.median(r["sharpe"] for r in random_runs),
            "limitations": ["next-open + 30s modeled by next open with fixed slippage",
                "two possible OHLC paths; no tick, latency, partial-fill or order-queue model",
                "fixed 0.1% quote fees; runtime commissions can use other assets",
                "runtime loss limits use gross PnL; reported economics are net",
                "fixed minimum notional 5 USDC, no historical lot/tick filter changes",
                "DCA baseline Sunday 08:00 Europe/Prague sampled on 4h bars, initial cash only, no fresh deposits",
                "no network/persistence failures simulated; verified separately by fault-injection",
                "no statistical edge or out-of-sample performance established"]}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache", type=Path, default=ROOT.parent / ".backtest_cache")
    parser.add_argument("--lock", type=Path, default=ROOT / "holdout-2026-09-21.json")
    parser.add_argument("--capital", type=float, default=1000)
    parser.add_argument("--seeds", type=int, default=40)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.seeds < 2:
        parser.error("At least two fixed random seeds required")
    result = run(args.cache, args.lock, capital=args.capital, seeds=args.seeds)
    # json cannot represent infinity; mark undefined ratios explicitly.
    import math
    def clean(value):
        if isinstance(value, float) and not math.isfinite(value): return None
        if isinstance(value, dict): return {k: clean(v) for k, v in value.items()}
        if isinstance(value, list): return [clean(v) for v in value]
        return value
    with args.output.open("x") as target:
        json.dump(clean(result), target, indent=2, default=str, allow_nan=False)
