"""
Ocean Strategy Lab - pragmaticka v1 validation pipeline.

Stages: DATA GATE -> BASELINE + BENCHMARK ARENA (vc. random-entry kontroly)
-> ROBUSTNOST (parameter sensitivity, stress test, Monte Carlo) -> FOLD
CONSISTENCY (walk-forward-style konzistence pres cas).

Zamerne VYNECHANO v teto verzi (roadmapa, az bude co gatovat):
  - OOS train/test lock + walk-forward re-fitting (nema smysl, dokud nic
    neladime na datech - vsechny parametry jsou dnes fixni produkcni hodnoty)
  - multi-agent role / promotion state machine / report-card UI

Spusteni:
    cd services/kryptotron/research && python3 validate.py
"""
from data import load_bars, validate_bars
from metrics import summarize, trade_stats, fold_returns, monte_carlo_drawdown, percentile_rank
import strategies as S

SYMBOLS = ["BTCUSDC", "ETHUSDC"]


def fmt_pct(x):
    return f"{x * 100:+.1f} %"


def print_summary_row(name, curve, trades=None):
    s = summarize(curve)
    line = (f"  {name:<32} CAGR {fmt_pct(s['cagr']):>8}  MaxDD {fmt_pct(s['max_dd']):>7}  "
            f"Sharpe {s['sharpe']:5.2f}  Sortino {s['sortino']:5.2f}  Calmar {s['calmar']:5.2f}")
    print(line)
    if trades:
        ts = trade_stats(trades, pnl_key="pnl_frac")
        print(f"       {'':<32} {ts['trades']} obchodu, win {ts['win_rate']:.0f} %, "
              f"expectancy {ts['expectancy']*100:+.2f} %/trade, PF {ts['profit_factor']:.2f}")
    return s


def stage1_data_gate(bars4h, bars15m):
    print(f"\n{'=' * 70}\nSTAGE 1 - DATA GATE\n{'=' * 70}")
    problems = []
    for symbol in SYMBOLS:
        problems += validate_bars(symbol, "4h", bars4h[symbol])
        problems += validate_bars(symbol, "15m", bars15m[symbol])
    if problems:
        print("  WARN - nalezene problemy (informativni, negatuje se rucne):")
        for p in problems:
            print(f"    - {p}")
    else:
        print("  PASS - zadne mezery, duplicity ani nekonzistentni OHLC")
    return len(problems) == 0


def stage2_baseline_and_benchmarks(bars4h, bars15m):
    print(f"\n{'=' * 70}\nSTAGE 2 - BASELINE + BENCHMARK ARENA\n{'=' * 70}")

    bh_curve, _ = S.buy_and_hold(bars4h)
    print_summary_row("Buy & Hold (50/50 BTC+ETH)", bh_curve)

    rw_curve, _ = S.random_price_walk(bars4h)
    print_summary_row("Random price walk (kontrola metriky)", rw_curve)

    value_curve, contributed_curve, contributions = S.simulate_dca(bars4h)
    total_contributed = contributed_curve[-1][1]
    final_value = value_curve[-1][1]
    dca_index = [(t, v / c) for (t, v), (_, c) in zip(value_curve, contributed_curve) if c > 0]
    from metrics import max_drawdown, daily_resample
    dca_daily = daily_resample(dca_index)
    dca_mdd = max_drawdown([v for _, v in dca_daily])
    money_weighted_r = S.dca_irr(value_curve, contributions)
    print(f"  {'DCA (tydenni, 50/50)':<32} MOIC {final_value/total_contributed:5.2f}x   "
          f"vlozeno {total_contributed:.1f}   hodnota {final_value:.1f}   "
          f"MaxDD(na vlozene) {fmt_pct(dca_mdd):>7}   "
          f"IRR {fmt_pct(money_weighted_r) if money_weighted_r is not None else 'n/a'}")

    gc_curve, gc_trades = S.golden_cross(bars4h)
    print_summary_row("Golden Cross (50/50 sleeves)", gc_curve, gc_trades)

    gc_rand_curve, gc_rand_trades = S.golden_cross(
        bars4h, entry_fn=S.make_random_trend_entry(probability=0.003, seed=1))
    print_summary_row("  -> RANDOM entry kontrola", gc_rand_curve, gc_rand_trades)

    regime_curve, regime_trades = S.golden_cross(bars4h, entry_fn=S._regime_entry)
    print_summary_row("Golden Cross - REGIME entry (kandidat)", regime_curve, regime_trades)

    st_curve, st_trades = S.streak(bars15m)
    print_summary_row("Streak pullback (15m)", st_curve, st_trades)

    st_rand_curve, st_rand_trades = S.streak(
        bars15m, signal_fn=S.make_random_pullback_signal(probability=0.012, seed=1))
    print_summary_row("  -> RANDOM entry kontrola", st_rand_curve, st_rand_trades)

    blend_curve, blend_trades = S.blend(bars4h, S.golden_cross)
    print_summary_row("Core-satellite blend (50% B&H + 50% GC)", blend_curve, blend_trades)

    rebal_curve, _ = S.rebalance(bars4h)
    print_summary_row("BTC/ETH tydenni rebalance", rebal_curve)

    return {
        "buy_hold": bh_curve, "golden_cross": (gc_curve, gc_trades),
        "golden_cross_random": (gc_rand_curve, gc_rand_trades),
        "golden_cross_regime": (regime_curve, regime_trades),
        "streak": (st_curve, st_trades), "streak_random": (st_rand_curve, st_rand_trades),
    }


def _calibrate_random_probability(bars4h, target_trades, lo=0.0003, hi=0.2, max_iter=18):
    """Binarni hledani pravdepodobnosti random-entry, aby pocet obchodu
    odpovidal target_trades (frekvence realne strategie) - bez tohohle
    neni srovnani s random kontrolou ferove."""
    for _ in range(max_iter):
        mid = (lo + hi) / 2
        _, trades = S.golden_cross(bars4h, entry_fn=S.make_random_trend_entry(probability=mid, seed=0))
        n = len(trades)
        if n < target_trades:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2


def stage2b_random_control_distribution(bars4h, baseline, n_seeds=40):
    print(f"\n{'=' * 70}\nSTAGE 2B - RANDOM CONTROL DISTRIBUCE (frekvenc. kalibrovana, {n_seeds} seedu)\n{'=' * 70}")
    print("Jeden random seed muze byt smula/stesti - tady se srovnava realny\n"
          "signal proti rozdeleni z N random-entry behu se STEJNYM poctem obchodu.\n")
    for name in ["golden_cross", "golden_cross_regime"]:
        curve, trades = baseline[name]
        real_s = summarize(curve)
        target = len(trades)
        p = _calibrate_random_probability(bars4h, target)
        sharpes, cagrs = [], []
        for seed in range(1, n_seeds + 1):
            c, t = S.golden_cross(bars4h, entry_fn=S.make_random_trend_entry(probability=p, seed=seed))
            s = summarize(c)
            sharpes.append(s["sharpe"])
            cagrs.append(s["cagr"])
        sharpes.sort()
        pct = percentile_rank(real_s["sharpe"], sharpes)
        print(f"  {name} ({target} obchodu, kalibrovana p={p:.4f}):")
        print(f"    realny Sharpe {real_s['sharpe']:.2f}   |   random rozdeleni: "
              f"min {sharpes[0]:.2f}  median {sharpes[len(sharpes)//2]:.2f}  max {sharpes[-1]:.2f}")
        print(f"    -> realny signal je na {pct:.0f}. percentilu random rozdeleni "
              f"{'(silny signal, ne sum)' if pct >= 90 else '(slaby/zadny signal nad ramec frekvence)' if pct < 70 else '(mirny signal)'}")


def stage3_robustness(bars4h, bars15m, baseline):
    print(f"\n{'=' * 70}\nSTAGE 3 - ROBUSTNOST\n{'=' * 70}")

    for label, entry_fn in [("Golden Cross (cross-timing)", S._golden_cross_entry),
                             ("Golden Cross (REGIME entry)", S._regime_entry)]:
        print(f"\n[3a] Parameter sensitivity - {label} EMA fast/slow (BTCUSDC, Sharpe)")
        fasts = [40, 45, 50, 55, 60]
        slows = [150, 175, 200, 225, 250]
        header = "        " + "".join(f"slow={s:<6}" for s in slows)
        print(header)
        for fast in fasts:
            row = f"  fast={fast:<3} "
            for slow in slows:
                curve, _ = S.simulate_trend_symbol(bars4h["BTCUSDC"], entry_fn=entry_fn, ema_fast=fast, ema_slow=slow)
                s = summarize(curve)
                row += f"{s['sharpe']:7.2f} "
            print(row)
    print("  (produkcni hodnota: fast=50, slow=200 - hleda se plateau kolem ni, ne spicka)")

    print("\n[3b] Stress test (2x fees + 2x slippage)")
    for name, sym_fn in [("Golden Cross (cross-timing)", lambda: S.golden_cross(
                              bars4h, fee_rate=S.FEE_RATE * 2, slippage_rate=S.SLIPPAGE_RATE * 2)),
                          ("Golden Cross (REGIME entry)", lambda: S.golden_cross(
                              bars4h, entry_fn=S._regime_entry,
                              fee_rate=S.FEE_RATE * 2, slippage_rate=S.SLIPPAGE_RATE * 2)),
                          ("Streak pullback", lambda: S.streak(
                              bars15m, fee_rate=S.FEE_RATE * 2, slippage_rate=S.SLIPPAGE_RATE * 2))]:
        curve, trades = sym_fn()
        print_summary_row(f"  {name} @ 2x naklady", curve, trades)

    print("\n[3c] Monte Carlo - reshuffle poradi obchodu (2000 simulaci)")
    for name, (curve, trades) in [("Golden Cross (cross-timing)", baseline["golden_cross"]),
                                   ("Golden Cross (REGIME entry)", baseline["golden_cross_regime"]),
                                   ("Streak pullback", baseline["streak"])]:
        mc = monte_carlo_drawdown(trades)
        if mc is None:
            continue
        real_mdd = summarize(curve)["max_dd"]
        print(f"  {name:<20} historicky MaxDD {fmt_pct(real_mdd):>7}   "
              f"MC medianDD {fmt_pct(mc['p50_dd']):>7}   "
              f"MC 95th-perc DD {fmt_pct(mc['p95_dd']):>7}   "
              f"MC nejhorsi DD {fmt_pct(mc['worst_dd']):>7}")


def stage4_fold_consistency(baseline, n_folds=6):
    print(f"\n{'=' * 70}\nSTAGE 4 - FOLD CONSISTENCY (walk-forward-style, {n_folds} oken)\n{'=' * 70}")
    bh_folds = fold_returns(baseline["buy_hold"], n_folds)
    for name in ["golden_cross", "golden_cross_regime", "streak"]:
        curve, _ = baseline[name]
        folds = fold_returns(curve, n_folds)
        common = min(len(folds), len(bh_folds))
        wins = sum(1 for i in range(common) if folds[i]["return"] > bh_folds[i]["return"])
        print(f"\n  {name} vs Buy&Hold po oknech ({wins}/{common} oken vyhrava nad B&H):")
        for i in range(common):
            f, b = folds[i], bh_folds[i]
            mark = "OK " if f["return"] > b["return"] else "   "
            print(f"    {mark}{f['start']} -> {f['end']}: strategie {fmt_pct(f['return']):>8}   "
                  f"B&H {fmt_pct(b['return']):>8}")


if __name__ == "__main__":
    bars4h = {s: load_bars(s, "4h") for s in SYMBOLS}
    bars15m = {s: load_bars(s, "15m") for s in SYMBOLS}

    stage1_data_gate(bars4h, bars15m)
    baseline = stage2_baseline_and_benchmarks(bars4h, bars15m)
    stage2b_random_control_distribution(bars4h, baseline)
    stage3_robustness(bars4h, bars15m, baseline)
    stage4_fold_consistency(baseline)
