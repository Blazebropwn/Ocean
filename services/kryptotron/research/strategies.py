"""
Kanonicke strategie pro validation pipeline. Kazda vraci (curve, trades):
  curve  = list[(timestamp_ms, equity)]  (equity normalizovane, start ~1.0)
  trades = list[dict] s klicem "pnl_frac" = zmena CELKOVEHO equity z obchodu
           (equity_po = equity_pred * (1 + pnl_frac)) - jednotny format, aby
           šel pouzit Monte Carlo reshuffle napric strategiemi.

Golden cross a streak sdileji stejny "shell" (stejny exit/stop/sizing system)
s realnym i s random-entry signalem, aby slo poctive testovat: ma vstupni
signal vubec nejakou hodnotu navic k tomu, co uz dava exit/sizing system sam?
"""
import random
import sys
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).parent.parent))
from utils import calculate_ema  # noqa: E402
from streak_strategy import ema as streak_ema, size_paper_setup, paper_close_result  # noqa: E402

FEE_RATE = 0.001
SLIPPAGE_RATE = 0.0005
PRAGUE = ZoneInfo("Europe/Prague")


def _align(bars_by_symbol):
    symbols = list(bars_by_symbol)
    common_ts = sorted(set.intersection(*[set(b["t"] for b in bars_by_symbol[s]) for s in symbols]))
    idx = {s: {b["t"]: b for b in bars_by_symbol[s]} for s in symbols}
    return symbols, common_ts, idx


# ---------------------------------------------------------------- benchmarks

def buy_and_hold(bars_by_symbol, weights=None):
    symbols, common_ts, idx = _align(bars_by_symbol)
    weights = weights or {s: 1 / len(symbols) for s in symbols}
    entry = {s: idx[s][common_ts[0]]["close"] for s in symbols}
    shares = {s: (weights[s] * (1 - FEE_RATE)) / entry[s] for s in symbols}
    curve = [(t, sum(shares[s] * idx[s][t]["close"] for s in symbols)) for t in common_ts]
    return curve, []


def random_price_walk(bars_by_symbol, seed=1):
    """Kontrola merice: nahodna equity curve se stejnou volatilitou jako trh
    (kazdy den nahodne + nebo - realny denni return jednoho z assetu), aby
    slo overit, ze i "hloupa" ale volatilni curve nema systematicky lepsi
    Sharpe jen diky mechanice metriky."""
    symbols, common_ts, idx = _align(bars_by_symbol)
    rng = random.Random(seed)
    rets = []
    for s in symbols:
        closes = [idx[s][t]["close"] for t in common_ts]
        rets.extend(b / a - 1 for a, b in zip(closes, closes[1:]))
    equity = 1.0
    curve = [(common_ts[0], equity)]
    for t in common_ts[1:]:
        r = rng.choice(rets) * rng.choice([-1, 1])
        equity *= (1 + r)
        curve.append((t, equity))
    return curve, []


def simulate_dca(bars_by_symbol, weekly_amount=1.0, weights=None):
    symbols, common_ts, idx = _align(bars_by_symbol)
    weights = weights or {s: 1 / len(symbols) for s in symbols}

    shares = {s: 0.0 for s in symbols}
    contributed = 0.0
    contributions = []
    last_week = None
    value_curve = []
    contributed_curve = []

    for t in common_ts:
        dt = datetime.fromtimestamp(t / 1000, tz=timezone.utc).astimezone(PRAGUE)
        if dt.weekday() == 6 and dt.hour >= 8:
            wk = dt.isocalendar()[:2]
            if wk != last_week:
                last_week = wk
                for s in symbols:
                    amt = weekly_amount * weights[s]
                    price = idx[s][t]["close"] * (1 + SLIPPAGE_RATE)
                    shares[s] += amt * (1 - FEE_RATE) / price
                    contributed += amt
                contributions.append((t, weekly_amount))
        value = sum(shares[s] * idx[s][t]["close"] for s in symbols)
        value_curve.append((t, value))
        contributed_curve.append((t, contributed))
    return value_curve, contributed_curve, contributions


def dca_irr(value_curve, contributions):
    """Money-weighted rocni vynos. t=0 je datum prvniho vkladu; kazdy dalsi
    cashflow ma t rostouci smerem k end_date (standardni NPV konvence -
    pozdejsi cashflow = vic diskontovany, ne naopak)."""
    from metrics import irr
    if not contributions or value_curve[-1][1] <= 0:
        return None
    year_ms = 1000 * 60 * 60 * 24 * 365.25
    start_t = contributions[0][0]
    end_t = value_curve[-1][0]
    cashflows = [((t - start_t) / year_ms, -amt) for t, amt in contributions]
    cashflows.append(((end_t - start_t) / year_ms, value_curve[-1][1]))
    return irr(cashflows)


# ------------------------------------------------------------- golden cross

def _golden_cross_entry(ema_f, ema_s, i):
    return ema_f[i - 1] <= ema_s[i - 1] and ema_f[i] > ema_s[i]


def make_random_trend_entry(probability=0.01, seed=1):
    rng = random.Random(seed)

    def fn(ema_f, ema_s, i):
        return rng.random() < probability
    return fn


def simulate_trend_symbol(bars, entry_fn=_golden_cross_entry, ema_fast=50, ema_slow=200,
                           max_sl_pct=10.0, trail_activate_pct=3.0, trail_distance_pct=1.5,
                           fee_rate=FEE_RATE, slippage_rate=SLIPPAGE_RATE):
    closes = [b["close"] for b in bars]
    ema_f = calculate_ema(closes, ema_fast)
    ema_s = calculate_ema(closes, ema_slow)

    cash = 1.0
    shares = 0.0
    in_position = False
    entry_price = highest_price = trail_sl = 0.0
    trail_active = False
    active_sl = None
    entry_cash = 1.0

    curve, trades = [], []
    warmup = ema_slow + 1
    for i in range(warmup, len(bars)):
        bar = bars[i]
        death_cross = ema_f[i - 1] >= ema_s[i - 1] and ema_f[i] < ema_s[i]

        if in_position:
            if active_sl is not None and bar["low"] <= active_sl:
                exit_price = active_sl * (1 - slippage_rate)
                cash = shares * exit_price * (1 - fee_rate)
                trades.append({"reason": "STOP", "pnl_frac": cash / entry_cash - 1})
                shares, in_position, active_sl = 0.0, False, None
            elif death_cross:
                exit_price = bar["close"] * (1 - slippage_rate)
                cash = shares * exit_price * (1 - fee_rate)
                trades.append({"reason": "DEATH_CROSS", "pnl_frac": cash / entry_cash - 1})
                shares, in_position, active_sl = 0.0, False, None
            else:
                if bar["high"] > highest_price:
                    highest_price = bar["high"]
                gain_from_high = (highest_price - entry_price) / entry_price * 100
                if gain_from_high >= trail_activate_pct:
                    new_trail = highest_price * (1 - trail_distance_pct / 100)
                    if new_trail > trail_sl:
                        trail_sl = new_trail
                        trail_active = True
                active_sl = trail_sl if trail_active else entry_price * (1 - max_sl_pct / 100)
        else:
            if entry_fn(ema_f, ema_s, i):
                entry_price = bar["close"] * (1 + slippage_rate)
                entry_cash = cash
                shares = cash * (1 - fee_rate) / entry_price
                cash = 0.0
                highest_price = entry_price
                trail_active = False
                trail_sl = 0.0
                active_sl = entry_price * (1 - max_sl_pct / 100)
                in_position = True

        equity = cash if not in_position else shares * bar["close"]
        curve.append((bar["t"], equity))

    return curve, trades


def _combine_portfolio(per_symbol_results, weights):
    """per_symbol_results: {symbol: (curve, trades)}. Kazda sleeve dostane
    fixni podil kapitalu, ktery se dal nerebalancuje (nezavisle sleeves)."""
    symbols = list(per_symbol_results)
    curves = {s: dict(per_symbol_results[s][0]) for s in symbols}
    common_ts = sorted(set.intersection(*[set(curves[s]) for s in symbols]))
    curve = [(t, sum(weights[s] * curves[s][t] for s in symbols)) for t in common_ts]
    trades = []
    for s in symbols:
        for tr in per_symbol_results[s][1]:
            trades.append({**tr, "symbol": s, "pnl_frac": weights[s] * tr["pnl_frac"]})
    trades.sort(key=lambda t: t.get("t", 0))
    return curve, trades


def golden_cross(bars_by_symbol, weights=None, entry_fn=_golden_cross_entry, **params):
    symbols = list(bars_by_symbol)
    weights = weights or {s: 1 / len(symbols) for s in symbols}
    per_symbol = {s: simulate_trend_symbol(bars_by_symbol[s], entry_fn=entry_fn, **params) for s in symbols}
    return _combine_portfolio(per_symbol, weights)


# -------------------------------------------------------------------- streak

def trend_pullback_signal(closes, lows):
    if len(closes) < 55 or len(lows) != len(closes):
        return None, "INSUFFICIENT_DATA"
    fast = streak_ema(closes, 20)
    slow = streak_ema(closes, 50)
    if fast[-1] <= slow[-1]:
        return None, "NO_UPTREND"
    if not (closes[-2] <= fast[-2] and closes[-1] > fast[-1]):
        return None, "NO_PULLBACK_RECLAIM"
    entry = float(closes[-1])
    stop = float(min(lows[-6:]))
    distance = (entry - stop) / entry
    if distance < 0.002:
        return None, "STOP_TOO_TIGHT"
    if distance > 0.02:
        return None, "STOP_TOO_WIDE"
    return {"entry_price": entry, "stop_price": stop}, "SIGNAL"


def make_random_pullback_signal(probability=0.05, seed=1):
    rng = random.Random(seed)

    def fn(closes, lows):
        if len(closes) < 55:
            return None, "INSUFFICIENT_DATA"
        if rng.random() > probability:
            return None, "NO_ROLL"
        entry = float(closes[-1])
        stop = float(min(lows[-6:]))
        distance = (entry - stop) / entry
        if distance < 0.002:
            return None, "STOP_TOO_TIGHT"
        if distance > 0.02:
            return None, "STOP_TOO_WIDE"
        return {"entry_price": entry, "stop_price": stop}, "SIGNAL"
    return fn


def _session_date(ts_ms):
    return datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc).astimezone(PRAGUE).date()


def streak(bars_by_symbol, signal_fn=trend_pullback_signal, risk_fraction=0.01,
           max_capital_fraction=0.5, signal_window=59,
           fee_rate=FEE_RATE, slippage_rate=SLIPPAGE_RATE):
    symbols, common_ts, idx = _align(bars_by_symbol)
    order = {s: {b["t"]: i for i, b in enumerate(bars_by_symbol[s])} for s in symbols}

    cash = 1.0
    in_position = False
    pos = None
    locked_date = None
    trades, curve = [], []

    for t in common_ts:
        cur_date = _session_date(t)
        if locked_date is not None and cur_date > locked_date:
            locked_date = None

        if in_position:
            symbol = pos["symbol"]
            bar = bars_by_symbol[symbol][order[symbol][t]]
            if t != pos["opened_ts"]:
                setup = pos["setup"]
                exit_price, reason = None, None
                if bar["low"] <= setup.stop_price:
                    exit_price, reason = setup.stop_price, "STOP"
                elif bar["high"] >= setup.target_price:
                    exit_price, reason = setup.target_price, "TARGET"
                if exit_price is not None:
                    result = paper_close_result(setup, exit_price, fee_rate, slippage_rate)
                    cash_before = pos["cash_at_entry"]
                    cash = cash_before + result["net_pnl"]
                    trades.append({
                        "symbol": symbol, "reason": reason, "t": t,
                        "pnl_frac": result["net_pnl"] / cash_before,
                        "r_multiple": result["net_pnl"] / setup.risk_usdc,
                    })
                    if result["net_pnl"] < 0:
                        locked_date = cur_date
                    in_position = False
                    pos = None
                    curve.append((t, cash))
                    continue
            equity = pos["cash_at_entry"] - pos["setup"].quote_size + pos["setup"].quantity * bar["close"]
            curve.append((t, equity))
            continue

        if locked_date is None:
            opened = False
            for symbol in symbols:
                bars = bars_by_symbol[symbol]
                i = order[symbol][t]
                lo = max(0, i - signal_window + 1)
                closes = [b["close"] for b in bars[lo:i + 1]]
                lows = [b["low"] for b in bars[lo:i + 1]]
                signal, _reason = signal_fn(closes, lows)
                if signal is None:
                    continue
                setup, size_reason = size_paper_setup(
                    symbol, signal["entry_price"], signal["stop_price"],
                    available_quote=cash, risk_usdc=risk_fraction * cash,
                    max_capital_fraction=max_capital_fraction, min_notional=0.0,
                    fee_rate=fee_rate, slippage_rate=slippage_rate,
                )
                if setup is None:
                    continue
                in_position = True
                pos = {"symbol": symbol, "setup": setup, "opened_ts": t, "cash_at_entry": cash}
                opened = True
                break
            if opened:
                curve.append((t, cash))
                continue
        curve.append((t, cash))

    return curve, trades


# ------------------------------------------------------- allocation overlays

def blend(bars_by_symbol, satellite_fn, core_weight=0.5, **satellite_kwargs):
    bh_curve, _ = buy_and_hold(bars_by_symbol)
    sat_curve, sat_trades = satellite_fn(bars_by_symbol, **satellite_kwargs)
    bh_d, sat_d = dict(bh_curve), dict(sat_curve)
    common = sorted(set(bh_d) & set(sat_d))
    curve = [(t, core_weight * bh_d[t] + (1 - core_weight) * sat_d[t]) for t in common]
    trades = [{**tr, "pnl_frac": (1 - core_weight) * tr["pnl_frac"]} for tr in sat_trades]
    return curve, trades


def rebalance(bars_by_symbol, weights=None, every_bars=42):
    symbols, common_ts, idx = _align(bars_by_symbol)
    weights = weights or {s: 1 / len(symbols) for s in symbols}
    entry = {s: idx[s][common_ts[0]]["close"] for s in symbols}
    shares = {s: (weights[s] * (1 - FEE_RATE)) / entry[s] for s in symbols}
    curve = []
    for i, t in enumerate(common_ts):
        prices = {s: idx[s][t]["close"] for s in symbols}
        equity = sum(shares[s] * prices[s] for s in symbols)
        curve.append((t, equity))
        if i > 0 and i % every_bars == 0:
            for s in symbols:
                shares[s] = (equity * weights[s] * (1 - FEE_RATE)) / prices[s]
    return curve, []
