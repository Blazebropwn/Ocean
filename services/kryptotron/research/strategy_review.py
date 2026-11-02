"""Offline comparison on known pre-holdout data; never promotes or places orders.

Signals are computed from closed 4h candles by the existing rolling worker code.
Execution is approximated with 15m OHLC paths. All candidate rules are fixed,
not parameter-searched. The historical validation fold is NOT a pristine holdout.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import platform
import pandas

from data import to_bars, validate_bars
from metrics import summarize, max_drawdown, trade_stats
from production_model import STEP, rolling_signals, oco_price
from risk import entry_permission, position_budget
from config import settings

ROOT = Path(__file__).resolve().parent
STEP15 = 15 * 60_000
SYMBOLS = ("BTCUSDC", "ETHUSDC")
VARIANTS = ("regime", "fresh_cross", "above_fast", "rising_fast")
COSTS = {"base": (.001, .0005), "double": (.002, .001)}


def ms(date):
    return int(datetime.fromisoformat(date).replace(tzinfo=timezone.utc).timestamp() * 1000)


def iso(timestamp):
    return datetime.fromtimestamp(timestamp / 1000, timezone.utc).isoformat()


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def entry_signal(variant, current, previous=None):
    if variant not in VARIANTS:
        raise ValueError(f"Unknown variant: {variant}")
    if not current["bull"]:
        return False
    if variant == "regime":
        return True
    if variant == "fresh_cross":
        return current["golden_cross"]
    above = current["close"] > current["ema_fast"]
    if variant == "above_fast":
        return above
    return above and previous is not None and current["ema_fast"] > previous["ema_fast"]


def load_data(cache, protocol, start=ms("2023-03-25")):
    """Reject gaps and aggregation mismatches; never load candles past the cutoff."""
    cutoff = min(protocol["train_end_ms"], protocol["test_start_ms"])
    start = max(start, protocol["train_start_ms"])
    bars4, bars15, sources = {}, {}, {}
    for symbol in SYMBOLS:
        for interval, step, destination in (("4h", STEP, bars4), ("15m", STEP15, bars15)):
            path = cache / f"{symbol}_{interval}.json"
            observed_at = path.stat().st_mtime * 1000
            rows = [row for row in json.loads(path.read_text())
                    if start <= row[0] and row[0] + step <= cutoff and row[6] < observed_at]
            bars = to_bars(rows)
            errors = validate_bars(symbol, interval, bars)
            if errors:
                raise ValueError("; ".join(errors))
            destination[symbol] = bars
            sources[path.name] = {"sha256": digest(path), "mtime_ns": path.stat().st_mtime_ns,
                "selected_start": iso(bars[0]["t"]), "selected_end_exclusive": iso(bars[-1]["t"] + step),
                "selected_rows": len(bars)}
    first = max(values[0]["t"] for values in [*bars4.values(), *bars15.values()])
    last = min(values[-1]["t"] + step for collection, step in ((bars4, STEP), (bars15, STEP15))
               for values in collection.values())
    # Only trim boundary history to complete 4h windows; never intersect away gaps.
    first = ((first + STEP - 1) // STEP) * STEP
    last = (last // STEP) * STEP
    for collection in (bars4, bars15):
        for symbol in SYMBOLS:
            collection[symbol] = [bar for bar in collection[symbol] if first <= bar["t"] < last]
        if [bar["t"] for bar in collection[SYMBOLS[0]]] != [bar["t"] for bar in collection[SYMBOLS[1]]]:
            raise ValueError("Symbols are not aligned")
    for symbol in SYMBOLS:
        fine = {bar["t"]: bar for bar in bars15[symbol]}
        for coarse in bars4[symbol]:
            window = [fine.get(coarse["t"] + n * STEP15) for n in range(16)]
            if any(bar is None for bar in window):
                raise ValueError("Incomplete 15m execution window")
            aggregate = {"open": window[0]["open"], "high": max(bar["high"] for bar in window),
                         "low": min(bar["low"] for bar in window), "close": window[-1]["close"]}
            if any(not math.isclose(coarse[key], aggregate[key], rel_tol=1e-10, abs_tol=1e-10) for key in aggregate):
                raise ValueError(f"15m/4h OHLC mismatch: {symbol} {iso(coarse['t'])}")
    if len(bars4[SYMBOLS[0]]) <= settings.EMA_SLOW_PERIOD + 10:
        raise ValueError("No evaluation history after warmup")
    return bars4, bars15, sources


def simulate(bars4, bars15, signals, *, variant="regime", start_ms, end_ms,
             capital=100.0, fee=.001, slippage=.0005, path="low_first"):
    if variant not in (*VARIANTS, "buy_hold", "cash") or path not in ("low_first", "high_first"):
        raise ValueError("Invalid experiment variant/path")
    if capital <= 0 or not math.isfinite(capital) or not 0 <= fee < 1 or not 0 <= slippage < 1:
        raise ValueError("Invalid capital or costs")
    if start_ms >= end_ms:
        raise ValueError("Empty evaluation interval")
    symbols = list(bars4)
    signal_at = {symbol: {bars4[symbol][index]["t"]: (signal, signals[symbol].get(index - 1))
                        for index, signal in signals[symbol].items()} for symbol in symbols}
    fine = {symbol: {bar["t"]: bar for bar in bars15[symbol]} for symbol in symbols}
    times = [bar["t"] for bar in bars15[symbols[0]] if start_ms <= bar["t"] and bar["t"] + STEP15 <= end_ms]
    if not times or any(any(t not in fine[symbol] for t in times) for symbol in symbols):
        raise ValueError("Missing execution observations")
    cash, fees, orders = capital, 0.0, 0
    positions, trades = {}, []
    state = {"entries_paused": False, "daily_loss": 0.0, "weekly_loss": 0.0,
             "trades_today": 0, "trades_week": 0, "consecutive_losses": 0}
    day, week = None, None
    curve = [(times[0] - 1, 1.0)]

    def buy(symbol, budget, price, now):
        nonlocal cash, fees, orders
        spend = min(budget, cash / (1 + fee))
        if spend < 5:
            return
        execution = price * (1 + slippage)
        charge = spend * fee
        positions[symbol] = {"qty": spend / execution, "entry": execution,
            "cost": spend + charge, "peak": execution, "trail": False, "entry_t": int(now.timestamp() * 1000)}
        cash -= spend + charge
        fees += charge
        orders += 1
        state["trades_today"] += 1
        state["trades_week"] += 1
        state["last_trade_time"] = now.isoformat()

    def sell(symbol, price, now, reason):
        nonlocal cash, fees, orders
        position = positions.pop(symbol)
        proceeds = position["qty"] * price * (1 - slippage)
        charge = proceeds * fee
        net = proceeds - charge - position["cost"]
        gross = position["qty"] * (price * (1 - slippage) - position["entry"])
        cash += proceeds - charge
        fees += charge
        orders += 1
        # Match today's runtime gross loss/cooldown policy, report net economics.
        state["last_trade_time"] = now.isoformat()
        state["last_trade_result"] = "WIN" if gross >= 0 else "LOSS"
        state["consecutive_losses"] = 0 if gross >= 0 else state["consecutive_losses"] + 1
        if gross < 0:
            state["daily_loss"] += -gross
            state["weekly_loss"] += -gross
        trades.append({"symbol": symbol, "net_pnl": net, "reason": reason,
                       "entry_t": position["entry_t"], "exit_t": int(now.timestamp() * 1000)})

    for t in times:
        now = datetime.fromtimestamp(t / 1000, timezone.utc)
        if now.date() != day:
            state.update(daily_loss=0.0, trades_today=0)
            day = now.date()
        if now.isocalendar()[:2] != week:
            state.update(weekly_loss=0.0, trades_week=0)
            week = now.isocalendar()[:2]
        exited_at_open = set()
        # Known protection can execute on an opening gap before a new decision.
        if variant in VARIANTS:
            for symbol in list(positions):
                price = fine[symbol][t]["open"]
                point = {key: price for key in ("open", "high", "low", "close")}
                stop = oco_price(positions[symbol], point, path)
                if stop is not None:
                    sell(symbol, stop, now, "OCO_GAP_APPROXIMATION")
                    exited_at_open.add(symbol)
        if variant == "buy_hold" and t == times[0]:
            for symbol in symbols:
                buy(symbol, capital / len(symbols) / (1 + fee), fine[symbol][t]["open"], now)
        elif variant in VARIANTS and t % STEP == 0:
            for symbol in symbols:
                observation = signal_at[symbol].get(t)
                if observation is None:
                    continue
                current, previous = observation
                if symbol in positions:
                    # Same uninterrupted legacy exit across all entry candidates.
                    if current["death_cross"]:
                        sell(symbol, fine[symbol][t]["open"], now, "DEATH_CROSS")
                elif symbol not in exited_at_open and entry_permission(state, now, require_reconciliation=False)[0] == "ENTRY_ALLOWED":
                    if entry_signal(variant, current, previous):
                        buy(symbol, position_budget(cash), fine[symbol][t]["open"], now)
        if variant in VARIANTS:
            for symbol in list(positions):
                price = oco_price(positions[symbol], fine[symbol][t], path)
                if price is not None:
                    sell(symbol, price, datetime.fromtimestamp((t + STEP15 - 1) / 1000, timezone.utc), "OCO_15M_APPROXIMATION")
        equity = cash + sum(position["qty"] * fine[symbol][t]["close"] for symbol, position in positions.items())
        curve.append((t + STEP15 - 1, equity / capital))
    stats = summarize(curve)
    stats.update(trade_stats(trades, pnl_key="net_pnl"))
    stats.update(final_equity=curve[-1][1] * capital, max_dd_15m_close=max_drawdown([value for _, value in curve]),
                 fees_paid=fees, order_count=orders, open_positions=len(positions), closed_trade_count=len(trades))
    return stats, trades


def run(cache, lock, *, capitals=(100.0, 1000.0)):
    protocol = json.loads(lock.read_text())
    bars4, bars15, sources = load_data(cache, protocol)
    signals = {symbol: rolling_signals(values) for symbol, values in bars4.items()}
    first = bars4[SYMBOLS[0]][settings.EMA_SLOW_PERIOD + 9]["t"]
    end = bars4[SYMBOLS[0]][-1]["t"] + STEP
    split = ms("2025-01-01")
    if not first < split < end:
        raise ValueError("Historical validation split is outside the data")
    results = []
    for fold, start, stop in (("development", first, split), ("historical_validation", split, end)):
        for capital in capitals:
            for cost, (fee, slippage) in COSTS.items():
                for path in ("low_first", "high_first"):
                    for variant in (*VARIANTS, "buy_hold", "cash"):
                        stats, _ = simulate(bars4, bars15, signals, variant=variant,
                            start_ms=start, end_ms=stop, capital=capital, fee=fee, slippage=slippage, path=path)
                        results.append({"fold": fold, "start": iso(start), "end_exclusive": iso(stop),
                            "capital": capital, "cost": cost, "path": path, "variant": variant, "stats": stats})
    paths = [Path(__file__), ROOT.parent / "strategy.py", ROOT.parent / "risk.py", ROOT.parent / "config/settings.py",
             ROOT.parent / "utils.py", ROOT / "production_model.py", ROOT / "data.py", ROOT / "metrics.py"]
    return {"evaluation": "exploratory_pre_holdout_15m", "promotion_allowed": False,
        "historical_validation_is_pristine_oos": False, "protocol_sha256": digest(lock),
        "runtime": {"python": platform.python_version(), "pandas": pandas.__version__},
        "cutoff_exclusive": iso(min(protocol["train_end_ms"], protocol["test_start_ms"])),
        "sources": sources, "source_hashes": {str(path.relative_to(ROOT.parent)): digest(path) for path in paths},
        "configuration": {"variants": list(VARIANTS), "capitals": list(capitals), "split": iso(split),
            "fee_base": .001, "slippage_base": .0005, "stress_multiplier": 2,
            "position_pct": settings.POSITION_PCT, "max_position": settings.MAX_POSITION_USDT,
            "stop_pct": settings.MAX_SL_PCT, "trailing_activation_pct": settings.TRAIL_ACTIVATE_PCT,
            "trailing_distance_pct": settings.TRAIL_DISTANCE_PCT},
        "limitations": ["Previously examined historical data; split is not a fresh out-of-sample experiment",
            "15m OHLC still does not reveal tick path; two paths are scenarios, not bounds",
            "Next 4h boundary open approximates worker entry after 30s; fees/slippage fixed",
            "No lot rounding, historical filters, partial fills, network failures or actual order queue",
            "Risk limits/cooldowns use gross PnL as in today's runtime; performance uses net PnL",
            "No ongoing DCA deposits/other holdings; fixed capital and independent flat reset at each fold",
            "Passive comparator fully invested 50/50; exposure differs from the capped active strategy",
            "Terminal open positions marked to market without hypothetical exit fee",
            "Original uninterrupted death-cross exit held fixed for entry comparisons; outage recovery tested separately",
            "Default min notional 5 USDC; fills at modeled stop/gap prices are approximations",
            "No statistical edge, production promotion or future performance established"],
        "results": results}


def clean(value):
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if isinstance(value, dict):
        return {key: clean(item) for key, item in value.items()}
    if isinstance(value, (tuple, list)):
        return [clean(item) for item in value]
    return value


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache", type=Path, default=ROOT.parent / ".backtest_cache")
    parser.add_argument("--lock", type=Path, default=ROOT / "holdout-2026-09-21.json")
    parser.add_argument("--capitals", type=float, nargs="+", default=[100.0, 1000.0])
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    result = run(args.cache, args.lock, capitals=tuple(args.capitals))
    with args.output.open("x") as target:
        json.dump(clean(result), target, indent=2, default=str, allow_nan=False)
        target.write("\n")
    print(f"Wrote {len(result['results'])} scenarios to {args.output}; promotion_allowed=false")
