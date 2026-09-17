"""Metriky nad equity curve (list of (timestamp_ms, equity)) a trade listem."""
from datetime import datetime, timezone


def daily_resample(curve):
    daily = {}
    for t, eq in curve:
        day = datetime.fromtimestamp(t / 1000, tz=timezone.utc).date()
        daily[day] = eq  # posledni hodnota dne prepise predchozi
    return sorted(daily.items())


def max_drawdown(values):
    peak = values[0]
    mdd = 0.0
    for v in values:
        peak = max(peak, v)
        mdd = min(mdd, (v - peak) / peak)
    return mdd


def sharpe(values):
    rets = [b / a - 1 for a, b in zip(values, values[1:]) if a > 0]
    if len(rets) < 2:
        return 0.0
    mean = sum(rets) / len(rets)
    var = sum((r - mean) ** 2 for r in rets) / (len(rets) - 1)
    std = var ** 0.5
    return (mean / std) * (365 ** 0.5) if std else 0.0


def sortino(values):
    rets = [b / a - 1 for a, b in zip(values, values[1:]) if a > 0]
    if len(rets) < 2:
        return 0.0
    mean = sum(rets) / len(rets)
    downside = [min(0.0, r) for r in rets]
    dvar = sum(r ** 2 for r in downside) / len(downside)
    dstd = dvar ** 0.5
    return (mean / dstd) * (365 ** 0.5) if dstd else 0.0


def calmar(cagr_value, mdd):
    return cagr_value / abs(mdd) if mdd else 0.0


def cagr(values, years):
    if years <= 0:
        return 0.0
    return values[-1] ** (1 / years) - 1 if values[-1] > 0 else -1.0


def summarize(curve):
    daily = daily_resample(curve)
    vals = [v for _, v in daily]
    days = [d for d, _ in daily]
    years = (days[-1] - days[0]).days / 365.25
    c = cagr(vals, years)
    mdd = max_drawdown(vals)
    return {
        "start": days[0], "end": days[-1], "years": years,
        "final": vals[-1], "total_return": vals[-1] - 1,
        "cagr": c, "max_dd": mdd, "sharpe": sharpe(vals),
        "sortino": sortino(vals), "calmar": calmar(c, mdd),
    }


def trade_stats(trades, pnl_key="net_return"):
    """trades: list of dicts obsahujici pnl_key (frakce/R vraceny z obchodu)."""
    if not trades:
        return {
            "trades": 0, "win_rate": 0.0, "avg_win": 0.0, "avg_loss": 0.0,
            "payoff_ratio": 0.0, "expectancy": 0.0, "profit_factor": 0.0,
        }
    wins = [t[pnl_key] for t in trades if t[pnl_key] > 0]
    losses = [t[pnl_key] for t in trades if t[pnl_key] <= 0]
    win_rate = len(wins) / len(trades)
    avg_win = sum(wins) / len(wins) if wins else 0.0
    avg_loss = sum(losses) / len(losses) if losses else 0.0
    payoff = avg_win / abs(avg_loss) if avg_loss else float("inf")
    expectancy = win_rate * avg_win + (1 - win_rate) * avg_loss
    gross_win = sum(wins)
    gross_loss = -sum(losses)
    profit_factor = gross_win / gross_loss if gross_loss > 0 else float("inf")
    return {
        "trades": len(trades), "win_rate": win_rate * 100,
        "avg_win": avg_win, "avg_loss": avg_loss,
        "payoff_ratio": payoff, "expectancy": expectancy,
        "profit_factor": profit_factor,
    }


def fold_returns(curve, n_folds=6):
    daily = daily_resample(curve)
    days = [d for d, _ in daily]
    vals = [v for _, v in daily]
    n = len(vals)
    if n < n_folds * 2:
        return []
    size = n // n_folds
    folds = []
    for i in range(n_folds):
        start = i * size
        end = (i + 1) * size if i < n_folds - 1 else n - 1
        folds.append({
            "start": days[start], "end": days[end],
            "return": vals[end] / vals[start] - 1,
        })
    return folds


def monte_carlo_drawdown(trades, n_sims=2000, seed=7):
    import random
    pnl_fracs = [t["pnl_frac"] for t in trades]
    if not pnl_fracs:
        return None
    rng = random.Random(seed)
    finals, mdds = [], []
    for _ in range(n_sims):
        seq = pnl_fracs[:]
        rng.shuffle(seq)
        equity = peak = 1.0
        mdd = 0.0
        for r in seq:
            equity *= (1 + r)
            peak = max(peak, equity)
            mdd = min(mdd, (equity - peak) / peak)
        finals.append(equity)
        mdds.append(mdd)
    finals.sort()
    mdds.sort()

    def pct(vals, p):
        return vals[int(p * (len(vals) - 1))]

    return {
        "median_final": pct(finals, 0.5),
        "p50_dd": pct(mdds, 0.5),
        "p95_dd": pct(mdds, 0.05),
        "p99_dd": pct(mdds, 0.01),
        "worst_dd": mdds[0],
    }


def irr(cashflows, lo=-0.99, hi=10.0, iters=100):
    """Money-weighted rocni vynos pro nerovnomerne cashflow (napr. DCA).

    cashflows: list of (years_before_end, amount) - zaporne = vklad,
    kladne = konecna hodnota (v case 0, tj. years_before_end=0).
    """
    def npv(r):
        return sum(cf / (1 + r) ** t for t, cf in cashflows)

    flo, fhi = npv(lo), npv(hi)
    if flo * fhi > 0:
        return None
    for _ in range(iters):
        mid = (lo + hi) / 2
        fmid = npv(mid)
        if flo * fmid <= 0:
            hi = mid
        else:
            lo, flo = mid, fmid
    return (lo + hi) / 2
