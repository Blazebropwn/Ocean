"""
Binance Trading Bot — Golden Cross / Death Cross
=================================================
Strategie: 4h EMA50 > EMA200 = drž pozici (Golden Cross)
           4h EMA50 < EMA200 = zavři pozici (Death Cross)
Trailing stop: aktivuje se při +3% zisku, sleduje 1.5% pod maximem
Nouzový SL: -10% od vstupu
Kontrola každé 4 hodiny.
"""

import time
import json
import logging
from datetime import datetime, timedelta, timezone
from pathlib import Path

from binance.client import Client
from binance.exceptions import BinanceAPIException

import db
from config.settings import (
    API_KEY, API_SECRET, TESTNET,
    PAIRS, QUOTE_ASSET,
    EMA_FAST_PERIOD, EMA_SLOW_PERIOD, MAX_SL_PCT, PRE_CROSS_PCT,
    TRAIL_ACTIVATE_PCT, TRAIL_DISTANCE_PCT,
    POSITION_PCT, MAX_POSITION_USDT,
    MAX_DAILY_LOSS_USDT, MAX_WEEKLY_LOSS_USDT,
    MAX_CONSECUTIVE_LOSSES, MAX_TRADES_PER_DAY, MAX_TRADES_PER_WEEK,
    COOLDOWN_AFTER_LOSS_HRS, COOLDOWN_AFTER_WIN_HRS,
    TELEGRAM_TOKEN, TELEGRAM_CHAT_ID,
)
from strategy import get_cross_data
from utils import get_balance, get_symbol_filters, round_step, round_price, notify

Path("logs").mkdir(exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.FileHandler("logs/bot.log"),
        logging.StreamHandler(),
    ]
)
log = logging.getLogger(__name__)

STATE_FILE = Path("state.json")

DEFAULT_PAIR_STATE = {
    "in_position":        False,
    "position_qty":       0.0,
    "entry_price":        0.0,
    "entry_time":         None,
    "highest_price":      0.0,
    "trail_active":       False,
    "trail_sl":           0.0,
    "pre_cross_alerted":  "",  # datum posledního pre-cross alertu (YYYY-MM-DD)
}

DEFAULT_STATE = {
    "positions":            {},
    "daily_loss":           0.0,
    "daily_loss_date":      "",
    "weekly_loss":          0.0,
    "weekly_loss_week":     -1,
    "consecutive_losses":   0,
    "trades_today":         0,
    "trades_week":          0,
    "trades_week_num":      -1,
    "last_trade_time":      None,
    "last_trade_result":    None,
    "last_heartbeat_week":  "",
    "runtime_status":       "starting",
    "last_heartbeat_at":    None,
    "last_market_check_at": None,
    "next_check_at":        None,
    "last_error":           None,
}

DIVIDER = "─" * 22


def tg(msg):
    notify(TELEGRAM_TOKEN, TELEGRAM_CHAT_ID, msg)


def now_utc():
    return datetime.now(timezone.utc)


def get_pair_state(state, symbol):
    if symbol not in state["positions"]:
        state["positions"][symbol] = DEFAULT_PAIR_STATE.copy()
    else:
        for k, v in DEFAULT_PAIR_STATE.items():
            state["positions"][symbol].setdefault(k, v)
    return state["positions"][symbol]


def load_state():
    sb = db.load_state()
    if sb is not None:
        log.info("State načten ze Supabase")
        for k, v in DEFAULT_STATE.items():
            sb.setdefault(k, v)
        return sb
    if STATE_FILE.exists():
        with open(STATE_FILE) as f:
            s = json.load(f)
        for k, v in DEFAULT_STATE.items():
            s.setdefault(k, v)
        if "positions" not in s:
            s["positions"] = {}
        log.info("State načten z lokálního souboru")
        return s
    return DEFAULT_STATE.copy()


def save_state(state):
    db.save_state(state)
    with open(STATE_FILE, "w") as f:
        json.dump(state, f, indent=2, default=str)


def reset_periods(state):
    today = now_utc().strftime("%Y-%m-%d")
    if state["daily_loss_date"] != today:
        state.update(daily_loss=0.0, daily_loss_date=today, trades_today=0)
    wk = now_utc().isocalendar()[1]
    if state["weekly_loss_week"] != wk:
        state.update(weekly_loss=0.0, weekly_loss_week=wk, trades_week=0, trades_week_num=wk)
    return state


def can_trade(state):
    if state["daily_loss"] >= MAX_DAILY_LOSS_USDT:
        return False, f"Denní ztráta: -{state['daily_loss']:.2f} {QUOTE_ASSET}"
    if state["weekly_loss"] >= MAX_WEEKLY_LOSS_USDT:
        return False, f"Týdenní ztráta: -{state['weekly_loss']:.2f} {QUOTE_ASSET}"
    if state["trades_today"] >= MAX_TRADES_PER_DAY:
        return False, f"Max obchodů/den ({MAX_TRADES_PER_DAY}) dosaženo"
    if state["trades_week"] >= MAX_TRADES_PER_WEEK:
        return False, f"Max obchodů/týden ({MAX_TRADES_PER_WEEK}) dosaženo"
    if state["last_trade_time"]:
        last    = datetime.fromisoformat(state["last_trade_time"])
        elapsed = (now_utc() - last).total_seconds() / 3600
        if state["consecutive_losses"] >= MAX_CONSECUTIVE_LOSSES and elapsed < COOLDOWN_AFTER_LOSS_HRS:
            return False, f"Cooldown po ztrátách: {COOLDOWN_AFTER_LOSS_HRS - elapsed:.1f}h zbývá"
        if state["last_trade_result"] == "WIN" and elapsed < COOLDOWN_AFTER_WIN_HRS:
            return False, f"Cooldown po zisku: {COOLDOWN_AFTER_WIN_HRS - elapsed:.1f}h zbývá"
    return True, "OK"


def sell_market(client, ps, symbol, step_size):
    qty   = str(round_step(ps["position_qty"], step_size))
    order = client.order_market_sell(symbol=symbol, quantity=qty)
    fills = order.get("fills", [])
    if fills:
        total_qty   = sum(float(f["qty"]) for f in fills)
        total_quote = sum(float(f["qty"]) * float(f["price"]) for f in fills)
        return total_quote / total_qty
    return ps["entry_price"]


def record_close(state, symbol, exit_price, reason):
    ps      = state["positions"][symbol]
    pnl     = (exit_price - ps["entry_price"]) * ps["position_qty"]
    pnl_pct = (exit_price - ps["entry_price"]) / ps["entry_price"] * 100
    result  = "WIN" if pnl >= 0 else "LOSS"

    duration_str = ""
    if ps.get("entry_time"):
        entry_dt     = datetime.fromisoformat(ps["entry_time"])
        elapsed_secs = (now_utc() - entry_dt).total_seconds()
        days         = int(elapsed_secs // 86400)
        hours        = int((elapsed_secs % 86400) // 3600)
        duration_str = f"\n⏱️ Délka: {days}d {hours}h"

    if pnl >= 0:
        log.info(f"[{symbol}] WIN +{pnl:.2f} {QUOTE_ASSET}")
        tg(
            f"✅ <b>PRODÁNO — {symbol}</b>\n"
            f"{DIVIDER}\n"
            f"📋 Důvod: <b>{reason}</b>\n"
            f"📈 Entry: {ps['entry_price']:.2f} → Exit: {exit_price:.2f}\n"
            f"💰 Zisk: <b>+{pnl:.2f} {QUOTE_ASSET}</b> ({pnl_pct:+.2f}%)"
            f"{duration_str}"
        )
        state["last_trade_result"]  = "WIN"
        state["consecutive_losses"] = 0
    else:
        log.info(f"[{symbol}] LOSS {pnl:.2f} {QUOTE_ASSET}")
        tg(
            f"🔴 <b>PRODÁNO — {symbol}</b>\n"
            f"{DIVIDER}\n"
            f"📋 Důvod: <b>{reason}</b>\n"
            f"📉 Entry: {ps['entry_price']:.2f} → Exit: {exit_price:.2f}\n"
            f"💸 Ztráta: <b>{pnl:.2f} {QUOTE_ASSET}</b> ({pnl_pct:+.2f}%)"
            f"{duration_str}"
        )
        state["last_trade_result"]  = "LOSS"
        state["consecutive_losses"] += 1
        state["daily_loss"]         += abs(pnl)
        state["weekly_loss"]        += abs(pnl)

    db.log_trade(symbol, ps["entry_price"], exit_price, ps["position_qty"],
                 pnl, result, reason=reason, entry_time=ps.get("entry_time"))

    ps.update(
        in_position=False, position_qty=0.0, entry_price=0.0, entry_time=None,
        highest_price=0.0, trail_active=False, trail_sl=0.0, pre_cross_alerted="",
    )
    state["last_trade_time"] = now_utc().isoformat()
    return state


def sleep_until_next_4h_candle(state, cycle_errors):
    n          = now_utc()
    h_in_block = n.hour % 4
    secs_past  = h_in_block * 3600 + n.minute * 60 + n.second
    wait       = 4 * 3600 - secs_past + 30
    state.update(
        runtime_status="degraded" if cycle_errors else "waiting",
        last_heartbeat_at=n.isoformat(),
        last_market_check_at=n.isoformat(),
        next_check_at=(n + timedelta(seconds=wait)).isoformat(),
        last_error=cycle_errors[-1] if cycle_errors else None,
    )
    save_state(state)
    log.info(f"Čekám {wait // 3600}h {(wait % 3600) // 60}m na další 4h svíčku…")
    time.sleep(wait)


def run():
    if not API_KEY or not API_SECRET:
        log.error("Chybí BINANCE_API_KEY nebo BINANCE_API_SECRET!")
        raise SystemExit(1)

    symbols = [p["symbol"] for p in PAIRS]
    mode    = "🔴 MAINNET" if not TESTNET else "🟡 TESTNET"
    log.info("=" * 55)
    log.info(f"Bot spuštěn | Páry: {symbols} | TESTNET={TESTNET}")
    log.info(f"Strategie: Golden Cross EMA{EMA_FAST_PERIOD}/EMA{EMA_SLOW_PERIOD} na 4h")
    log.info(f"Trail: aktivace +{TRAIL_ACTIVATE_PCT}% | vzdálenost -{TRAIL_DISTANCE_PCT}%")
    log.info("=" * 55)

    db.init()

    try:
        import urllib.request
        current_ip = urllib.request.urlopen("https://api.ipify.org", timeout=5).read().decode()
        log.info(f"Outbound IP: {current_ip}")
        tg(f"🌐 <b>Railway IP:</b> <code>{current_ip}</code>\nPřidej na Binance pokud se změnila.")
    except Exception:
        pass

    client = Client(API_KEY, API_SECRET, testnet=TESTNET)

    try:
        pair_filters = {}
        for pair in PAIRS:
            sym = pair["symbol"]
            step_size, tick_size, min_notional = get_symbol_filters(client, sym)
            pair_filters[sym] = (step_size, tick_size, min_notional)
            log.info(f"[{sym}] step={step_size} | tick={tick_size} | minNotional={min_notional}")
    except Exception as e:
        log.error(f"Chyba při inicializaci párů: {e}")
        tg(f"❌ <b>Bot se nespustil!</b>\n{e}")
        raise SystemExit(1)

    state = load_state()
    save_state(state)

    balance = get_balance(client, QUOTE_ASSET)
    tg(
        f"🚀 <b>Bot spuštěn</b>\n"
        f"{DIVIDER}\n"
        f"📊 Strategie: Golden Cross EMA{EMA_FAST_PERIOD}/EMA{EMA_SLOW_PERIOD} (4h)\n"
        f"💱 Páry: {' | '.join(symbols)}\n"
        f"💰 Balance: <b>{balance:.2f} {QUOTE_ASSET}</b>\n"
        f"🛡️ SL: -{MAX_SL_PCT}% | Trail: +{TRAIL_ACTIVATE_PCT}% → -{TRAIL_DISTANCE_PCT}%\n"
        f"⚙️ Režim: {mode}"
    )

    _last_summary_d = ""

    while True:
        cycle_errors = []
        state.update(
            runtime_status="running",
            last_heartbeat_at=now_utc().isoformat(),
            next_check_at=None,
        )
        save_state(state)
        try:
            state     = reset_periods(state)
            pair_data = {}

            for pair in PAIRS:
                symbol = pair["symbol"]
                base   = pair["base"]
                step_size, tick_size, min_notional = pair_filters[symbol]
                ps     = get_pair_state(state, symbol)

                try:
                    data              = get_cross_data(client, symbol, EMA_FAST_PERIOD, EMA_SLOW_PERIOD)
                    pair_data[symbol] = data
                    trend_str         = "🟢 BULL" if data["bull"] else "🔴 BEAR"
                    cross_str         = " ⚡ GOLDEN CROSS!" if data["golden_cross"] else \
                                        " ☠️ DEATH CROSS!"  if data["death_cross"]  else ""
                    log.info(
                        f"[{symbol}] {data['close']:.2f} | "
                        f"EMA{EMA_FAST_PERIOD}: {data['ema_fast']:.2f} | "
                        f"EMA{EMA_SLOW_PERIOD}: {data['ema_slow']:.2f} | "
                        f"{trend_str}{cross_str}"
                    )

                    # ── V POZICI ─────────────────────────────────────────────
                    if ps["in_position"]:
                        # Aktualizuj nejvyšší cenu (použij 4h high)
                        if data["high"] > ps.get("highest_price", ps["entry_price"]):
                            ps["highest_price"] = data["high"]

                        # Trailing stop logika
                        gain_from_high = (ps["highest_price"] - ps["entry_price"]) / ps["entry_price"] * 100
                        if gain_from_high >= TRAIL_ACTIVATE_PCT:
                            new_trail = ps["highest_price"] * (1 - TRAIL_DISTANCE_PCT / 100)
                            if new_trail > ps.get("trail_sl", 0.0):
                                was_active    = ps.get("trail_active", False)
                                ps["trail_sl"]     = new_trail
                                ps["trail_active"] = True
                                if not was_active:
                                    log.info(f"[{symbol}] Trailing stop aktivován @ {new_trail:.2f}")
                                    tg(
                                        f"🛡️ <b>Trailing stop aktivován — {symbol}</b>\n"
                                        f"{DIVIDER}\n"
                                        f"📈 Nejvyšší cena: {ps['highest_price']:.2f}\n"
                                        f"🔒 Trail SL: <b>{new_trail:.2f}</b> (-{TRAIL_DISTANCE_PCT}% od maxima)\n"
                                        f"Chráním zisk před pádem 💪"
                                    )

                        active_sl = ps["trail_sl"] if ps.get("trail_active") else \
                                    ps["entry_price"] * (1 - MAX_SL_PCT / 100)
                        pnl_pct   = (data["close"] - ps["entry_price"]) / ps["entry_price"] * 100
                        trail_tag = " [TRAIL ✅]" if ps.get("trail_active") else ""

                        log.info(
                            f"[{symbol}] Pozice: entry={ps['entry_price']:.2f} | "
                            f"P/L: {pnl_pct:+.2f}% | High: {ps['highest_price']:.2f} | "
                            f"SL: {active_sl:.2f}{trail_tag}"
                        )

                        if data["death_cross"]:
                            log.info(f"[{symbol}] Death Cross — prodávám")
                            ep    = sell_market(client, ps, symbol, step_size)
                            state = record_close(state, symbol, ep, "DEATH_CROSS")
                            save_state(state)

                        elif data["low"] <= active_sl or data["close"] <= active_sl:
                            reason = "TRAIL_SL" if ps.get("trail_active") else "STOP_LOSS"
                            log.warning(f"[{symbol}] {reason} ({pnl_pct:.2f}%) — prodávám")
                            ep    = sell_market(client, ps, symbol, step_size)
                            state = record_close(state, symbol, ep, reason)
                            save_state(state)

                    # ── BEZ POZICE ────────────────────────────────────────────
                    else:
                        if data["golden_cross"]:
                            allowed, reason = can_trade(state)
                            if not allowed:
                                log.info(f"[{symbol}] Golden Cross ale trading pozastaven: {reason}")
                                tg(f"⚠️ <b>Golden Cross — {symbol}</b>\nTrading pozastaven: {reason}")
                            else:
                                balance = get_balance(client, QUOTE_ASSET, raise_on_error=True)
                                spend   = min(balance * POSITION_PCT / 100, MAX_POSITION_USDT)

                                if spend < min_notional:
                                    log.warning(f"[{symbol}] Nedostatečný balance: {balance:.2f} {QUOTE_ASSET}")
                                    tg(f"⚠️ <b>Golden Cross — {symbol}</b>\nNedostatečný balance: {balance:.2f} {QUOTE_ASSET}")
                                else:
                                    log.info(f"[{symbol}] ⚡ GOLDEN CROSS — Nakupuji za {spend:.2f} {QUOTE_ASSET}")
                                    order       = client.order_market_buy(
                                        symbol=symbol,
                                        quoteOrderQty=str(round(spend, 2)),
                                    )
                                    qty_filled  = float(order["executedQty"])
                                    quote_spent = float(order["cummulativeQuoteQty"])
                                    entry_price = quote_spent / qty_filled

                                    log.info(f"[{symbol}] Nakoupeno: {qty_filled} {base} @ {entry_price:.2f}")
                                    tg(
                                        f"⚡ <b>GOLDEN CROSS — {symbol}</b>\n"
                                        f"{DIVIDER}\n"
                                        f"💵 Nakoupeno: <b>{qty_filled} {base}</b>\n"
                                        f"📈 Cena vstupu: <b>{entry_price:.2f} {QUOTE_ASSET}</b>\n"
                                        f"🎯 Strategie: drž do Death Cross\n"
                                        f"🛡️ Nouzový SL: {entry_price * (1 - MAX_SL_PCT / 100):.2f} | "
                                        f"Trail aktivace: +{TRAIL_ACTIVATE_PCT}%"
                                    )

                                    ps.update(
                                        in_position=True,
                                        position_qty=qty_filled,
                                        entry_price=entry_price,
                                        entry_time=now_utc().isoformat(),
                                        highest_price=entry_price,
                                        trail_active=False,
                                        trail_sl=0.0,
                                        pre_cross_alerted="",
                                    )
                                    state["last_trade_time"] = now_utc().isoformat()
                                    state["trades_today"]   += 1
                                    state["trades_week"]    += 1
                                    save_state(state)
                        else:
                            gap_pct   = (data["ema_slow"] - data["ema_fast"]) / data["ema_slow"] * 100
                            today_str = now_utc().strftime("%Y-%m-%d")
                            log.info(f"[{symbol}] Čekám na Golden Cross | mezera EMA: {gap_pct:.2f}%")
                            if not data["bull"] and gap_pct <= PRE_CROSS_PCT \
                                    and ps.get("pre_cross_alerted") != today_str:
                                ps["pre_cross_alerted"] = today_str
                                tg(
                                    f"⚡ <b>Pre-Cross alert — {symbol}</b>\n"
                                    f"{DIVIDER}\n"
                                    f"EMA{EMA_FAST_PERIOD} je jen <b>{gap_pct:.2f}%</b> pod EMA{EMA_SLOW_PERIOD}\n"
                                    f"Golden Cross se blíží 👀"
                                )
                                save_state(state)

                except BinanceAPIException as e:
                    cycle_errors.append(f"{symbol}: Binance API chyba")
                    log.error(f"[{symbol}] Binance API chyba: {e}")
                    tg(f"❌ <b>API chyba — {symbol}</b>\n{e}")
                except Exception as e:
                    cycle_errors.append(f"{symbol}: {str(e)[:160]}")
                    log.error(f"[{symbol}] Chyba: {e}", exc_info=True)
                    tg(f"❌ <b>Chyba — {symbol}</b>\n{str(e)[:200]}")

            # ── BALANCE LOG ──────────────────────────────────────────────────
            balance   = get_balance(client, QUOTE_ASSET, raise_on_error=True)
            log.info(
                f"Balance: {balance:.2f} {QUOTE_ASSET} | "
                f"Ztráty: den={state['daily_loss']:.2f} týden={state['weekly_loss']:.2f}"
            )

            # ── DENNÍ SHRNUTÍ (půlnoc UTC) ───────────────────────────────────
            today_str = now_utc().strftime("%Y-%m-%d")
            if now_utc().hour == 0 and today_str != _last_summary_d:
                _last_summary_d = today_str
                lines = []
                for pair in PAIRS:
                    sym = pair["symbol"]
                    ps  = get_pair_state(state, sym)
                    d   = pair_data.get(sym)
                    if d:
                        trend = "🟢 BULL" if d["bull"] else "🔴 BEAR"
                        if ps["in_position"]:
                            pnl = (d["close"] - ps["entry_price"]) / ps["entry_price"] * 100
                            trail = " | 🛡️ Trail ON" if ps.get("trail_active") else ""
                            lines.append(f"<b>{sym}</b>: {trend} | P/L: {pnl:+.2f}%{trail}")
                        else:
                            lines.append(f"<b>{sym}</b>: {trend} — bez pozice")
                tg(
                    f"📊 <b>Denní shrnutí</b>\n"
                    f"{DIVIDER}\n"
                    f"{chr(10).join(lines)}\n"
                    f"{DIVIDER}\n"
                    f"💰 Balance: <b>{balance:.2f} {QUOTE_ASSET}</b>\n"
                    f"📉 Ztráta týden: {state['weekly_loss']:.2f} {QUOTE_ASSET}"
                )

            # ── TÝDENNÍ HEARTBEAT (každou neděli) ───────────────────────────
            if now_utc().weekday() == 6:
                week_key = now_utc().strftime("%Y-W%W")
                if state.get("last_heartbeat_week") != week_key:
                    state["last_heartbeat_week"] = week_key
                    lines = []
                    for pair in PAIRS:
                        sym = pair["symbol"]
                        ps  = get_pair_state(state, sym)
                        d   = pair_data.get(sym)
                        if d:
                            trend   = "🟢 BULL" if d["bull"] else "🔴 BEAR"
                            gap_pct = abs(d["ema_fast"] - d["ema_slow"]) / d["ema_slow"] * 100
                            if ps["in_position"]:
                                pnl   = (d["close"] - ps["entry_price"]) / ps["entry_price"] * 100
                                trail = " | 🛡️ Trail ON" if ps.get("trail_active") else ""
                                lines.append(f"<b>{sym}</b>: {trend} | V pozici <b>{pnl:+.2f}%</b>{trail}")
                            else:
                                direction = "nad" if d["bull"] else "pod"
                                lines.append(f"<b>{sym}</b>: {trend} | EMA mezera: {gap_pct:.2f}% {direction} EMA200")
                    tg(
                        f"💓 <b>Týdenní report</b>\n"
                        f"{DIVIDER}\n"
                        f"{chr(10).join(lines)}\n"
                        f"{DIVIDER}\n"
                        f"💰 Balance: <b>{balance:.2f} {QUOTE_ASSET}</b>\n"
                        f"📉 Ztráta týden: {state['weekly_loss']:.2f} {QUOTE_ASSET}\n"
                        f"🤖 Bot běží normálně ✅"
                    )
                    save_state(state)

        except BinanceAPIException as e:
            cycle_errors.append("Binance API chyba")
            log.error(f"Binance API chyba: {e}")
            tg(f"❌ <b>Binance API chyba</b>\n{e}")
        except Exception as e:
            cycle_errors.append(str(e)[:160])
            log.error(f"Neočekávaná chyba: {e}", exc_info=True)
            tg(f"❌ <b>Chyba bota</b>\n{str(e)[:300]}")

        sleep_until_next_4h_candle(state, cycle_errors)


if __name__ == "__main__":
    run()
