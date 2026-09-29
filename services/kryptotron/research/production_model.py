"""Separate exploratory model of the worker; never imported by the frozen holdout.

Signals use the actual worker's rolling EMA implementation. Orders are approximated
at the next bar open; OHLC cannot establish the true tick path of Binance OCO.
"""
from datetime import datetime, timezone
import random
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from strategy import get_cross_data
from risk import entry_permission, position_budget
from config import settings
from dca import dca_due, week_key
from metrics import summarize, trade_stats, max_drawdown, calmar

STEP = 4 * 60 * 60 * 1000


def rolling_signals(bars):
    class Window:
        def get_klines(self, **kwargs):
            return self.rows[-kwargs["limit"]:]
    client = Window()
    rows = [[b["t"], b["open"], b["high"], b["low"], b["close"], 0, b["t"]+STEP-1] for b in bars]
    signals = {}
    for i in range(settings.EMA_SLOW_PERIOD + 9, len(rows)):
        client.rows = rows[max(0, i-209):i+1]
        # The current row is discarded by the same worker function.
        signals[i] = get_cross_data(client, "RESEARCH", settings.EMA_FAST_PERIOD, settings.EMA_SLOW_PERIOD)
    return signals


def oco_price(position, bar, path):
    points = [bar["open"], bar["low"], bar["high"], bar["close"]] if path == "low_first" else [bar["open"], bar["high"], bar["low"], bar["close"]]
    previous = points[0]
    for index, price in enumerate(points):
        if price >= position["entry"] * (1+settings.TRAIL_ACTIVATE_PCT/100):
            position["trail"] = True
        if position["trail"]:
            position["peak"] = max(position["peak"], price)
        stop = position["entry"] * (1-settings.MAX_SL_PCT/100)
        if position["trail"]:
            stop = max(stop, position["peak"] * (1-settings.TRAIL_DISTANCE_PCT/100))
        if price <= stop:
            return price if index == 0 or previous <= stop else stop
        previous = price
    return None


def simulate(bars_by_symbol, signals, *, kind="regime", capital=1000.0, fee=.001, slippage=.0005,
             seed=1, random_probability=.04, path="low_first", min_notional=5.0):
    symbols = list(bars_by_symbol)
    times = [b["t"] for b in bars_by_symbol[symbols[0]]]
    if any([b["t"] for b in bars_by_symbol[s]] != times for s in symbols):
        raise ValueError("All symbols must have identical timestamps")
    if capital <= 0 or not 0 <= fee < 1 or not 0 <= slippage < 1:
        raise ValueError("Invalid capital/cost configuration")
    start = settings.EMA_SLOW_PERIOD + 9
    if len(times) <= start:
        raise ValueError("No observations after EMA warmup")
    rng = random.Random(seed)
    cash, fees, turnover, exposed, order_count = capital, 0.0, 0.0, 0, 0
    positions, trades = {}, []
    state = {"entries_paused": False, "daily_loss": 0.0, "weekly_loss": 0.0,
             "trades_today": 0, "trades_week": 0, "consecutive_losses": 0}
    last_day, last_week = None, None
    curve = [(times[start]-1, 1.0)]

    def buy(symbol, budget, price, now):
        nonlocal cash, fees, turnover, order_count
        spend = min(budget, cash/(1+fee))
        execution = price*(1+slippage)
        if spend < min_notional:
            return
        charge = spend*fee
        old = positions.get(symbol)
        quantity = spend/execution
        if old:
            old["qty"] += quantity
            old["cost"] += spend+charge
        else:
            positions[symbol] = {"qty": quantity, "entry": execution, "cost": spend+charge,
                                 "peak": execution, "trail": False, "entered": now.isoformat()}
        cash -= spend+charge
        fees += charge
        turnover += spend
        order_count += 1
        if kind in {"regime", "random"}:
            state["trades_today"] += 1
            state["trades_week"] += 1
            state["last_trade_time"] = now.isoformat()

    def sell(symbol, price, now, reason):
        nonlocal cash, fees, turnover, order_count
        p = positions.pop(symbol)
        proceeds = p["qty"]*price*(1-slippage)
        charge = proceeds*fee
        net = proceeds-charge-p["cost"]
        # Runtime currently enforces gross-PnL loss limits; retain that exact
        # rule here while reporting net economics and its limitation separately.
        gross = p["qty"]*(price*(1-slippage)-p["entry"])
        cash += proceeds-charge
        fees += charge
        turnover += proceeds
        order_count += 1
        state["last_trade_time"] = now.isoformat()
        state["last_trade_result"] = "WIN" if gross >= 0 else "LOSS"
        state["consecutive_losses"] = 0 if gross >= 0 else state["consecutive_losses"]+1
        if gross < 0:
            state["daily_loss"] += -gross
            state["weekly_loss"] += -gross
        trades.append({"symbol": symbol, "net_return": net/p["cost"], "pnl_frac": net/capital,
                       "net_pnl": net, "reason": reason, "t": int(now.timestamp()*1000)})

    for i in range(start, len(times)):
        turnover_before = turnover
        now = datetime.fromtimestamp((times[i]+30_000)/1000, timezone.utc)
        day, week = now.date(), now.isocalendar()[:2]
        if day != last_day:
            state.update(daily_loss=0.0, trades_today=0)
            last_day = day
        if week != last_week:
            state.update(weekly_loss=0.0, trades_week=0)
            last_week = week
        had_position = bool(positions)
        if kind == "buy_hold" and i == start:
            for symbol in symbols:
                buy(symbol, capital/len(symbols)/(1+fee), bars_by_symbol[symbol][i]["open"], now)
        elif kind == "dca" and dca_due(state, now):
            # Equal initial endowment, no external deposits; fixed weekly spend.
            for symbol in symbols:
                buy(symbol, settings.DCA_AMOUNT_USDC, bars_by_symbol[symbol][i]["open"], now)
            state.setdefault("dca", {})["completed_week"] = week_key(now)
        elif kind in {"regime", "random"}:
            # Worker checks known protection first, then regime/risk in pair order.
            for symbol in symbols:
                bar, signal = bars_by_symbol[symbol][i], signals[symbol][i]
                if symbol in positions:
                    if signal["death_cross"]:
                        sell(symbol, bar["open"], now, "DEATH_CROSS")
                elif entry_permission(state, now, require_reconciliation=False)[0] == "ENTRY_ALLOWED":
                    entry = signal["bull"] if kind == "regime" else rng.random() < random_probability
                    if entry:
                        buy(symbol, position_budget(cash), bar["open"], now)
            # Both paths are scenarios, not a claim about real tick ordering.
            for symbol in list(positions):
                price = oco_price(positions[symbol], bars_by_symbol[symbol][i], path)
                if price is not None:
                    sell(symbol, price, now, "OCO_APPROXIMATION")
        if had_position or positions or turnover != turnover_before:
            exposed += 1
        equity = cash + sum(p["qty"]*bars_by_symbol[s][i]["close"] for s, p in positions.items())
        curve.append((times[i]+STEP-1, equity/capital))
    stats = summarize(curve)
    stats["max_dd"] = max_drawdown([value for _, value in curve])
    stats["calmar"] = calmar(stats["cagr"], stats["max_dd"])
    stats.update(trade_stats(trades, pnl_key="net_pnl"))
    if not trades:
        stats.update(win_rate=None, profit_factor=None, avg_win=None, avg_loss=None, payoff_ratio=None, expectancy=None)
    stats.update(time_in_market=exposed/(len(times)-start), turnover=turnover/capital, fees_paid=fees,
                 initial_capital=capital, open_positions=len(positions), closed_trade_count=len(trades),
                 order_count=order_count,
                 final_equity=curve[-1][1]*capital)
    return stats, curve, trades
