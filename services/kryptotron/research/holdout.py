"""Pre-register a future holdout for the research model, without trading APIs.

This tests the simplified research model, NOT production execution parity.
See README.md for the limitations and cache refresh procedure.
"""
import argparse
import hashlib
import json
import platform
from datetime import datetime, timezone
from pathlib import Path
import statistics

from data import load_bars, validate_bars
from metrics import summarize, percentile_rank
import strategies as S
from validate import _calibrate_random_probability

STEP = 4 * 60 * 60 * 1000
SYMBOLS = ("BTCUSDC", "ETHUSDC")
ROOT = Path(__file__).resolve().parent
PARAMS = dict(ema_fast=50, ema_slow=200, max_sl_pct=10.0,
              trail_activate_pct=3.0, trail_distance_pct=1.5,
              fee_rate=0.001, slippage_rate=0.0005)


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, allow_nan=False).encode()).hexdigest()


def implementation():
    import pandas
    files = [ROOT / name for name in ("holdout.py", "data.py", "strategies.py", "metrics.py", "validate.py")]
    files += [ROOT.parent / name for name in ("utils.py", "streak_strategy.py")]
    return {"files": {str(p.relative_to(ROOT.parent)): hashlib.sha256(p.read_bytes()).hexdigest()
                      for p in files}, "python": platform.python_version(), "pandas": pandas.__version__}


def timestamp(value):
    return int(datetime.strptime(value, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp() * 1000)


def check_data(bars):
    for symbol in SYMBOLS:
        problems = validate_bars(symbol, "4h", bars[symbol])
        if problems:
            raise ValueError("; ".join(problems))
    if [b["t"] for b in bars[SYMBOLS[0]]] != [b["t"] for b in bars[SYMBOLS[1]]]:
        raise ValueError("Symbols must have identical timestamps; intersection would hide missing data")


def make_lock(bars, train_start, test_start, test_end, *, now_ms, n_seeds=40):
    if not train_start < now_ms < test_start < test_end:
        raise ValueError("Holdout must start in the future, after training")
    if any(t % STEP for t in (train_start, test_start, test_end)):
        raise ValueError("Boundaries must align with 4h candles")
    if test_end - test_start < 90 * 24 * 60 * 60 * 1000:
        raise ValueError("Pre-register at least 90 days; no early scoring")
    if n_seeds < 2:
        raise ValueError("At least two random controls required")
    training = {s: [b for b in bars[s] if train_start <= b["t"] and b["t"] + STEP <= now_ms]
                for s in SYMBOLS}
    check_data(training)
    if len(training[SYMBOLS[0]]) <= PARAMS["ema_slow"] + 1:
        raise ValueError("Training has no candles after warmup")
    if training[SYMBOLS[0]][0]["t"] != train_start:
        raise ValueError("Training must cover its requested start")
    _, trades = S.golden_cross(training, entry_fn=S._regime_entry, **PARAMS)
    if not trades:
        raise ValueError("Cannot calibrate frequency without completed training trades")
    probability = _calibrate_random_probability(training, len(trades))
    lock = {
        "version": 1, "created_at_ms": now_ms, "implementation": implementation(),
        "model": "research_regime_50_50_sleeves", "production_parity": False,
        "params": PARAMS.copy(), "train_start_ms": train_start,
        "train_end_ms": training[SYMBOLS[0]][-1]["t"] + STEP,
        "training_hash": digest(training), "test_start_ms": test_start, "test_end_ms": test_end,
        "random_probability": probability, "random_seeds": list(range(1, n_seeds + 1)),
        "training_closed_trades": len(trades),
        "primary_metric": "daily_sharpe_percentile_vs_training_calibrated_random_entries",
        "limitations": ["rolling production EMA differs", "intrabar OCO is not simulated",
                        "production sizing, cooldowns and shared risk limits are not simulated",
                        "random controls have approximate, not identical trade counts",
                        "no automatic strategy promotion"],
    }
    lock["protocol_hash"] = digest(lock)
    return lock


def evaluate(lock, bars, *, now_ms):
    if lock.get("protocol_hash") != digest({k: v for k, v in lock.items() if k != "protocol_hash"}):
        raise ValueError("Protocol changed")
    if lock["implementation"] != implementation():
        raise ValueError("Code or runtime changed since lock; use the frozen implementation")
    if now_ms < lock["test_end_ms"]:
        raise ValueError("Holdout still running; early scoring is disabled")
    training = {s: [b for b in bars[s] if lock["train_start_ms"] <= b["t"] < lock["train_end_ms"]]
                for s in SYMBOLS}
    if digest(training) != lock["training_hash"]:
        raise ValueError("Training snapshot changed")
    history = {s: [b for b in bars[s] if lock["train_start_ms"] <= b["t"] < lock["test_end_ms"]]
               for s in SYMBOLS}
    check_data(history)
    if history[SYMBOLS[0]][-1]["t"] + STEP != lock["test_end_ms"]:
        raise ValueError("Cache does not cover the full holdout; refresh closed candles")
    start = lock["test_start_ms"]
    params = lock["params"]

    def run(entry_fn, **overrides):
        curve, trades = S.golden_cross(history, entry_fn=entry_fn, trade_start_ms=start,
                                      **{**params, **overrides})
        # Include the initial cash NAV so the first bar's costs are not hidden.
        stats = summarize([(start - 1, 1.0)] + curve)
        return {**stats, "closed_trades": len(trades)}

    regime = run(S._regime_entry)
    controls = [run(S.make_random_trend_entry(lock["random_probability"], seed))
                for seed in lock["random_seeds"]]
    bh_bars = {s: [b for b in history[s] if b["t"] >= start] for s in SYMBOLS}
    bh_curve, _ = S.buy_and_hold(bh_bars)
    return {
        "protocol_hash": lock["protocol_hash"], "evaluated_at_ms": now_ms,
        "production_parity": False, "promotion_allowed": False,
        "holdout_hash": digest(bh_bars), "regime": regime,
        "cross_timing": run(S._golden_cross_entry),
        "buy_hold": summarize([(start - 1, 1.0)] + bh_curve),
        "double_cost": run(S._regime_entry, fee_rate=params["fee_rate"] * 2,
                           slippage_rate=params["slippage_rate"] * 2),
        "random_sharpe_percentile": percentile_rank(regime["sharpe"], [c["sharpe"] for c in controls]),
        "random_closed_trades": {"min": min(c["closed_trades"] for c in controls),
                                 "median": statistics.median(c["closed_trades"] for c in controls),
                                 "max": max(c["closed_trades"] for c in controls)},
        "random_runs": controls, "limitations": lock["limitations"],
    }


def write_new(path, value):
    with Path(path).open("x") as out:
        json.dump(value, out, indent=2, default=str, allow_nan=False)
        out.write("\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    create = sub.add_parser("lock")
    create.add_argument("--train-start", required=True)
    create.add_argument("--test-start", required=True)
    create.add_argument("--test-end", required=True, help="Exclusive UTC end date")
    create.add_argument("--output", required=True)
    score = sub.add_parser("evaluate")
    score.add_argument("--lock", required=True)
    score.add_argument("--output", required=True)
    args = parser.parse_args()
    now = int(datetime.now(timezone.utc).timestamp() * 1000)
    try:
        if args.command == "evaluate":
            lock = json.loads(Path(args.lock).read_text())
            if now < lock["test_end_ms"]:
                raise ValueError("Holdout still running; early scoring is disabled")
        bars = {s: load_bars(s, "4h") for s in SYMBOLS}
        if args.command == "lock":
            result = make_lock(bars, timestamp(args.train_start), timestamp(args.test_start),
                               timestamp(args.test_end), now_ms=now)
        else:
            result = evaluate(lock, bars, now_ms=now)
        write_new(args.output, result)
    except (ValueError, OSError) as exc:
        parser.exit(1, f"{exc}\n")
    print(args.output)


if __name__ == "__main__":
    main()
