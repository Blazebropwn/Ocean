"""
Backtest živé Golden Cross / Death Cross strategie (viz bot.py, strategy.py).

Stahuje kompletní historii 4h svíček z veřejného Binance REST API (bez API
klíče), simuluje vstupy a výstupy podle stejné logiky jako run() v bot.py
(golden/death cross, nouzový SL, trailing stop) a srovnává výsledek s prostým
buy-and-hold. Neřeší velikost účtu (POSITION_PCT / MAX_POSITION_USDT) — měří
kvalitu samotného signálu: 100 % kapitálu dovnitř při vstupu, 100 % ven při
výstupu, jako jedna nepřetržitá pozice na burze.

Spuštění:
    python3 backtest.py
"""
import json
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from utils import calculate_ema
from config.settings import (
    EMA_FAST_PERIOD, EMA_SLOW_PERIOD, MAX_SL_PCT,
    TRAIL_ACTIVATE_PCT, TRAIL_DISTANCE_PCT,
)

FEE_RATE = 0.001         # stejné jako streak_strategy.py
SLIPPAGE_RATE = 0.0005   # stejné jako streak_strategy.py
SYMBOLS = ["BTCUSDC", "ETHUSDC"]
INTERVAL = "4h"
CACHE_DIR = Path(__file__).parent / ".backtest_cache"
BINANCE_REST = "https://api.binance.com/api/v3/klines"


def fetch_klines(symbol):
    cache_file = CACHE_DIR / f"{symbol}_{INTERVAL}.json"
    if cache_file.exists():
        return json.loads(cache_file.read_text())

    CACHE_DIR.mkdir(exist_ok=True)
    klines = []
    start_time = 0
    while True:
        url = f"{BINANCE_REST}?symbol={symbol}&interval={INTERVAL}&startTime={start_time}&limit=1000"
        with urllib.request.urlopen(url, timeout=20) as resp:
            batch = json.loads(resp.read().decode())
        if not batch:
            break
        klines.extend(batch)
        if len(batch) < 1000:
            break
        start_time = batch[-1][0] + 1
        time.sleep(0.25)

    cache_file.write_text(json.dumps(klines))
    return klines


def to_bars(klines):
    return [
        {"t": k[0], "open": float(k[1]), "high": float(k[2]),
         "low": float(k[3]), "close": float(k[4])}
        for k in klines
    ]


def simulate(bars):
    closes = [b["close"] for b in bars]
    ema_fast = calculate_ema(closes, EMA_FAST_PERIOD)
    ema_slow = calculate_ema(closes, EMA_SLOW_PERIOD)

    cash = 1.0
    shares = 0.0
    in_position = False
    entry_price = highest_price = trail_sl = 0.0
    trail_active = False
    active_sl = None
    entry_cash = 1.0

    curve = []      # (timestamp_ms, equity)
    trades = []     # dicts s výsledkem každého obchodu

    warmup = EMA_SLOW_PERIOD + 1
    for i in range(warmup, len(bars)):
        bar = bars[i]
        golden_cross = ema_fast[i - 1] <= ema_slow[i - 1] and ema_fast[i] > ema_slow[i]
        death_cross = ema_fast[i - 1] >= ema_slow[i - 1] and ema_fast[i] < ema_slow[i]

        if in_position:
            if active_sl is not None and bar["low"] <= active_sl:
                exit_price = active_sl * (1 - SLIPPAGE_RATE)
                cash = shares * exit_price * (1 - FEE_RATE)
                trades.append({"entry": entry_price, "exit": exit_price,
                                "reason": "STOP", "net_return": cash / entry_cash - 1})
                shares, in_position, active_sl = 0.0, False, None
            elif death_cross:
                exit_price = bar["close"] * (1 - SLIPPAGE_RATE)
                cash = shares * exit_price * (1 - FEE_RATE)
                trades.append({"entry": entry_price, "exit": exit_price,
                                "reason": "DEATH_CROSS", "net_return": cash / entry_cash - 1})
                shares, in_position, active_sl = 0.0, False, None
            else:
                if bar["high"] > highest_price:
                    highest_price = bar["high"]
                gain_from_high = (highest_price - entry_price) / entry_price * 100
                if gain_from_high >= TRAIL_ACTIVATE_PCT:
                    new_trail = highest_price * (1 - TRAIL_DISTANCE_PCT / 100)
                    if new_trail > trail_sl:
                        trail_sl = new_trail
                        trail_active = True
                active_sl = trail_sl if trail_active else entry_price * (1 - MAX_SL_PCT / 100)
        else:
            if golden_cross:
                entry_price = bar["close"] * (1 + SLIPPAGE_RATE)
                entry_cash = cash
                shares = cash * (1 - FEE_RATE) / entry_price
                cash = 0.0
                highest_price = entry_price
                trail_active = False
                trail_sl = 0.0
                active_sl = entry_price * (1 - MAX_SL_PCT / 100)
                in_position = True

        equity = cash if not in_position else shares * bar["close"]
        curve.append((bar["t"], equity))

    return curve, trades


def buy_and_hold_curve(bars):
    warmup = EMA_SLOW_PERIOD + 1
    entry_price = bars[warmup]["close"] * (1 + SLIPPAGE_RATE)
    shares = (1.0 * (1 - FEE_RATE)) / entry_price
    return [(b["t"], shares * b["close"]) for b in bars[warmup:]]


def daily_resample(curve):
    daily = {}
    for t, eq in curve:
        day = datetime.fromtimestamp(t / 1000, tz=timezone.utc).date()
        daily[day] = eq  # poslední hodnota dne přepíše předchozí
    return sorted(daily.items())


def max_drawdown(curve_values):
    peak = curve_values[0]
    mdd = 0.0
    for v in curve_values:
        peak = max(peak, v)
        mdd = min(mdd, (v - peak) / peak)
    return mdd


def sharpe(daily_values):
    rets = []
    for a, b in zip(daily_values, daily_values[1:]):
        if a > 0:
            rets.append(b / a - 1)
    if len(rets) < 2:
        return 0.0
    mean = sum(rets) / len(rets)
    var = sum((r - mean) ** 2 for r in rets) / (len(rets) - 1)
    std = var ** 0.5
    if std == 0:
        return 0.0
    return (mean / std) * (365 ** 0.5)


def yearly_returns(curve):
    daily = daily_resample(curve)
    by_year = {}
    for day, eq in daily:
        by_year.setdefault(day.year, []).append(eq)
    out = {}
    for year, vals in sorted(by_year.items()):
        out[year] = vals[-1] / vals[0] - 1
    return out


def report(symbol, bars):
    curve, trades = simulate(bars)
    bh_curve = buy_and_hold_curve(bars)

    daily = daily_resample(curve)
    daily_vals = [v for _, v in daily]
    bh_daily = daily_resample(bh_curve)
    bh_vals = [v for _, v in bh_daily]

    start = datetime.fromtimestamp(bars[EMA_SLOW_PERIOD + 1]["t"] / 1000, tz=timezone.utc).date()
    end = datetime.fromtimestamp(bars[-1]["t"] / 1000, tz=timezone.utc).date()
    years = (end - start).days / 365.25

    final = daily_vals[-1]
    bh_final = bh_vals[-1]
    cagr = final ** (1 / years) - 1 if final > 0 else -1.0
    bh_cagr = bh_final ** (1 / years) - 1 if bh_final > 0 else -1.0

    wins = [t for t in trades if t["net_return"] > 0]
    losses = [t for t in trades if t["net_return"] <= 0]
    win_rate = len(wins) / len(trades) * 100 if trades else 0.0
    gross_win = sum(t["net_return"] for t in wins)
    gross_loss = -sum(t["net_return"] for t in losses)
    profit_factor = gross_win / gross_loss if gross_loss > 0 else float("inf")

    print(f"\n{'=' * 60}")
    print(f"{symbol}  |  {start} → {end}  ({years:.1f} let)")
    print(f"{'=' * 60}")
    print(f"Golden Cross strategie:")
    print(f"  Celkový výnos:      {(final - 1) * 100:+.1f} %")
    print(f"  CAGR:               {cagr * 100:+.1f} % / rok")
    print(f"  Max drawdown:       {max_drawdown(daily_vals) * 100:.1f} %")
    print(f"  Sharpe (denní, ann):{sharpe(daily_vals):.2f}")
    print(f"  Počet obchodů:      {len(trades)}")
    print(f"  Win rate:           {win_rate:.0f} %")
    print(f"  Profit factor:      {profit_factor:.2f}")
    print(f"\nBuy & Hold ({symbol}):")
    print(f"  Celkový výnos:      {(bh_final - 1) * 100:+.1f} %")
    print(f"  CAGR:               {bh_cagr * 100:+.1f} % / rok")
    print(f"  Max drawdown:       {max_drawdown(bh_vals) * 100:.1f} %")
    print(f"  Sharpe (denní, ann):{sharpe(bh_vals):.2f}")

    print(f"\nVýnos po rocích (strategie vs. buy&hold):")
    strat_yearly = yearly_returns(curve)
    bh_yearly = yearly_returns(bh_curve)
    for year in sorted(strat_yearly):
        s = strat_yearly[year] * 100
        b = bh_yearly.get(year, 0) * 100
        print(f"  {year}:  strategie {s:+7.1f} %   |   buy&hold {b:+7.1f} %")

    return {
        "symbol": symbol, "cagr": cagr, "bh_cagr": bh_cagr,
        "trades": len(trades), "win_rate": win_rate,
    }


if __name__ == "__main__":
    summary = []
    for symbol in SYMBOLS:
        bars = to_bars(fetch_klines(symbol))
        summary.append(report(symbol, bars))

    print(f"\n{'=' * 60}")
    print("SHRNUTÍ")
    print(f"{'=' * 60}")
    for s in summary:
        verdict = "strategie VYHRÁVÁ" if s["cagr"] > s["bh_cagr"] else "buy&hold VYHRÁVÁ"
        print(f"{s['symbol']}: CAGR {s['cagr']*100:+.1f}% vs B&H {s['bh_cagr']*100:+.1f}%  "
              f"({s['trades']} obchodů, {s['win_rate']:.0f}% win rate)  →  {verdict}")
