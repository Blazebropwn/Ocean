"""Offline, exploratory BTC/ETH versus SOL/ETH comparison before the frozen holdout.

Optional data download uses public klines only; this module never imports the bot
or an exchange client and has no order or account API access.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import platform
import time
import urllib.parse
import urllib.request

import pandas

from data import to_bars, validate_bars
from metrics import fold_returns
from production_model import STEP, rolling_signals, simulate
from config import settings

ROOT = Path(__file__).resolve().parent
SYMBOLS = ("BTCUSDC", "ETHUSDC", "SOLUSDC")
PORTFOLIOS = {
    "BTC_ETH": ("BTCUSDC", "ETHUSDC"),
    "SOL_ETH": ("SOLUSDC", "ETHUSDC"),
    "BTC_only": ("BTCUSDC",),
    "SOL_only": ("SOLUSDC",),
}
COSTS = {"base": (.001, .0005), "double": (.002, .001)}


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def utc(ms):
    return datetime.fromtimestamp(ms / 1000, timezone.utc).isoformat()


def bounds(protocol):
    start = protocol["train_start_ms"]
    end = min(protocol["train_end_ms"], protocol["test_start_ms"])
    if start >= end:
        raise ValueError("Empty pre-holdout interval")
    return start, end


def download_sol(path, protocol):
    """Never overwrite a snapshot or request candles from the held-out interval."""
    if path.exists():
        raise FileExistsError(path)
    cursor, end = bounds(protocol)
    rows = []
    observed_at = time.time() * 1000
    while cursor < end:
        query = urllib.parse.urlencode({"symbol": "SOLUSDC", "interval": "4h",
                                       "startTime": cursor, "endTime": end - 1, "limit": 1000})
        with urllib.request.urlopen("https://api.binance.com/api/v3/klines?" + query, timeout=20) as response:
            batch = json.load(response)
        if not batch:
            break
        if batch[-1][0] < cursor:
            raise ValueError("Pagination did not advance")
        rows.extend(row for row in batch if row[0] + STEP <= end and row[6] < observed_at)
        cursor = batch[-1][0] + STEP
        time.sleep(.25)
    errors = validate_bars("SOLUSDC", "4h", to_bars(rows))
    if errors:
        raise ValueError("; ".join(errors))
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("x") as target:
        json.dump(rows, target)


def aligned_bars(sources, protocol):
    """Trim only boundary history; reject interior gaps instead of intersecting them away."""
    start, end = bounds(protocol)
    selected = {}
    for symbol in SYMBOLS:
        path = sources[symbol]
        observed_at = path.stat().st_mtime * 1000
        rows = [row for row in json.loads(path.read_text())
                if start <= row[0] and row[0] + STEP <= end and row[6] < observed_at]
        if not rows:
            raise ValueError(f"{symbol}: no closed pre-holdout candles")
        selected[symbol] = rows
    common_start = max(rows[0][0] for rows in selected.values())
    common_end = min(rows[-1][0] + STEP for rows in selected.values())
    bars = {}
    for symbol, rows in selected.items():
        values = to_bars([row for row in rows if common_start <= row[0] < common_end])
        errors = validate_bars(symbol, "4h", values)
        if errors:
            raise ValueError("; ".join(errors))
        bars[symbol] = values
    timestamps = [b["t"] for b in bars["BTCUSDC"]]
    if any([b["t"] for b in values] != timestamps for values in bars.values()):
        raise ValueError("Symbols must have identical timestamps")
    if len(timestamps) <= settings.EMA_SLOW_PERIOD + 9:
        raise ValueError("No evaluation candles after EMA warmup")
    return bars


def yearly_returns(curve):
    previous = curve[0][1]
    groups = {}
    for timestamp, value in curve[1:]:
        year = datetime.fromtimestamp(timestamp / 1000, timezone.utc).year
        if year not in groups:
            groups[year] = {"start": utc(timestamp), "starting_equity": previous}
        groups[year].update(end=utc(timestamp), final_equity=value,
                            total_return=value / groups[year]["starting_equity"] - 1)
        previous = value
    return groups


def run(sources, lock, capitals=(100.0, 1000.0)):
    if not capitals or any(not math.isfinite(c) or c <= 0 for c in capitals):
        raise ValueError("Capital must be finite and positive")
    protocol = json.loads(lock.read_text())
    bars = aligned_bars(sources, protocol)
    signals = {}
    for symbol, values in bars.items():
        print(f"Signals: {symbol}, {len(values)} candles", flush=True)
        signals[symbol] = rolling_signals(values)
    runs = []
    for capital in capitals:
        for name, symbols in PORTFOLIOS.items():
            subset = {symbol: bars[symbol] for symbol in symbols}
            for path in ("low_first", "high_first"):
                for cost, (fee, slippage) in COSTS.items():
                    stats, curve, _ = simulate(subset, signals, capital=capital, path=path,
                                                fee=fee, slippage=slippage)
                    runs.append({"portfolio": name, "symbol_order": symbols, "capital": capital,
                                 "path": path, "cost": cost, "stats": stats,
                                 "yearly": yearly_returns(curve), "six_periods": fold_returns(curve)})
    first = bars["BTCUSDC"]
    sources_to_hash = [ROOT / "compare_pairs.py", ROOT / "production_model.py", ROOT / "data.py",
                       ROOT / "metrics.py", ROOT.parent / "strategy.py", ROOT.parent / "risk.py",
                       ROOT.parent / "utils.py", ROOT.parent / "config/settings.py",
                       ROOT.parent / "manual_close.py", ROOT.parent / "dca.py"]
    return {
        "evaluation": "exploratory_pre_holdout_pair_comparison", "promotion_allowed": False,
        "production_parity": "partial_explicit_execution_approximations",
        "python": platform.python_version(), "pandas": pandas.__version__,
        "protocol_sha256": digest(lock),
        "source_sha256": {str(p.relative_to(ROOT.parent)): digest(p) for p in sources_to_hash},
        "input_sha256": {s: digest(p) for s, p in sources.items()},
        "selected_data_sha256": hashlib.sha256(json.dumps(bars, sort_keys=True).encode()).hexdigest(),
        "period": {"data_start": utc(first[0]["t"]), "end_exclusive": utc(first[-1]["t"] + STEP),
                   "evaluation_start": utc(first[settings.EMA_SLOW_PERIOD + 9]["t"]),
                   "candles_per_symbol": len(first), "holdout_start": utc(protocol["test_start_ms"])},
        "configuration": {"capitals": capitals, "costs": COSTS, "dca_enabled": False,
                          "ema_fast": settings.EMA_FAST_PERIOD, "ema_slow": settings.EMA_SLOW_PERIOD,
                          "position_pct": settings.POSITION_PCT, "max_order_quote": settings.MAX_POSITION_USDT,
                          "stop_loss_pct": settings.MAX_SL_PCT, "trailing_activation_pct": settings.TRAIL_ACTIVATE_PCT,
                          "trailing_distance_pct": settings.TRAIL_DISTANCE_PCT,
                          "daily_loss_limit": settings.MAX_DAILY_LOSS_USDT,
                          "weekly_loss_limit": settings.MAX_WEEKLY_LOSS_USDT,
                          "max_trades_day": settings.MAX_TRADES_PER_DAY, "max_trades_week": settings.MAX_TRADES_PER_WEEK,
                          "loss_streak_limit": settings.MAX_CONSECUTIVE_LOSSES,
                          "loss_cooldown_hours": settings.COOLDOWN_AFTER_LOSS_HRS,
                          "win_cooldown_hours": settings.COOLDOWN_AFTER_WIN_HRS},
        "runs": runs,
        "limitations": [
            "Exploration on known history, not out-of-sample evidence or an automatic promotion decision.",
            "Same rolling signals, sizing and gross-PnL risk rules as the worker; economics include modeled fees and slippage.",
            "OHLC path scenarios are sensitivity checks, not guaranteed bounds; no ticks or real order fills.",
            "Fees are fixed quote fees, not account-specific historical commissions; no dynamic spreads or order-book depth.",
            "No quantity/tick rounding, residual inventory, historical filter changes or exchange protection rejects modeled.",
            "Minimum entry notional is fixed at 5 USDC; exit minimums are not modeled.",
            "No network failures, manual closes, restarts, concurrent DCA, fresh deposits or existing positions.",
            "Open positions at the end are marked to market without hypothetical exit fees.",
            "Partial boundary calendar years and six subperiods are slices of one continuous run, not independent tests.",
        ],
    }


def clean(value):
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if isinstance(value, dict):
        return {k: clean(v) for k, v in value.items()}
    if isinstance(value, (tuple, list)):
        return [clean(v) for v in value]
    return value


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache", type=Path, default=ROOT.parent / ".backtest_cache")
    parser.add_argument("--sol-data", type=Path, required=True)
    parser.add_argument("--download-sol", action="store_true")
    parser.add_argument("--lock", type=Path, default=ROOT / "holdout-2026-09-21.json")
    parser.add_argument("--capital", type=float, nargs="+", default=[100.0, 1000.0])
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists():
        parser.error("Existing report preserved; choose a new output path")
    if args.download_sol:
        download_sol(args.sol_data, json.loads(args.lock.read_text()))
    sources = {s: args.cache / f"{s}_4h.json" for s in SYMBOLS}
    sources["SOLUSDC"] = args.sol_data
    result = run(sources, args.lock, args.capital)
    with args.output.open("x") as target:
        json.dump(clean(result), target, indent=2, default=str, allow_nan=False)
