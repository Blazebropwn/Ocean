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
from order_safety import apply_filled_buy, classify_order, new_buy_intent
from events import add_event
from schedule import (
    daily_summary_due,
    mark_daily_summary_sent,
    mark_weekly_summary_sent,
    weekly_summary_due,
)
from protection import (
    build_protection_oco,
    cancel_protection,
    clear_protection,
    protection_outcome,
    query_protection,
    store_protection,
    trailing_delta_filter,
)

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
    "protection_order_list_id": None,
    "protection_client_id": None,
    "protection_status": None,
    "protection_stop_price": None,
    "protection_activation_price": None,
    "protection_trailing_bips": None,
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
    "pending_order":        None,
    "pending_protection":   None,
    "entries_paused":       False,
    "account_balance":      None,
    "quote_asset":          QUOTE_ASSET,
    "events":               [],
    "market_snapshot":      {},
    "last_daily_summary_date": "",
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
    remote_saved = db.save_state(state)
    temporary = STATE_FILE.with_suffix(".tmp")
    with open(temporary, "w") as f:
        json.dump(state, f, indent=2, default=str)
    temporary.replace(STATE_FILE)
    return remote_saved


def reconcile_pending_order(client, state):
    intent = state.get("pending_order")
    if not intent:
        return state
    if intent.get("side") != "BUY":
        raise RuntimeError("Neznámý nedokončený typ objednávky")
    order = client.get_order(
        symbol=intent["symbol"],
        origClientOrderId=intent["client_order_id"],
    )
    outcome = classify_order(order)
    if outcome == "filled":
        apply_filled_buy(state, intent, order)
        if not save_state(state):
            raise RuntimeError("Vyplněná objednávka nebyla bezpečně uložena")
        log.warning(f"[{intent['symbol']}] Obnovena vyplněná objednávka po restartu")
    elif outcome == "failed":
        state["pending_order"] = None
        if not save_state(state):
            raise RuntimeError("Zrušenou objednávku se nepodařilo bezpečně uložit")
    else:
        raise RuntimeError(f"Objednávka {intent['client_order_id']} stále čeká na dokončení")
    return state


def refresh_entries_control(state):
    remote_state = db.load_state()
    if remote_state is not None:
        state["entries_paused"] = remote_state.get("entries_paused", False)
    return state


def protection_request(symbol, ps, available_quantity, step_size, tick_size, trailing_bounds):
    return build_protection_oco(
        symbol=symbol,
        quantity=round_step(min(ps["position_qty"], available_quantity), step_size),
        entry_price=ps["entry_price"],
        tick_size=tick_size,
        max_loss_pct=MAX_SL_PCT,
        trail_activate_pct=TRAIL_ACTIVATE_PCT,
        trail_distance_pct=TRAIL_DISTANCE_PCT,
        min_trailing_bips=trailing_bounds[0],
        max_trailing_bips=trailing_bounds[1],
    )


def place_protection(client, state, symbol, request):
    ps = get_pair_state(state, symbol)
    state["pending_protection"] = request
    if not save_state(state):
        state["pending_protection"] = None
        save_state(state)
        raise RuntimeError("Bezpečný zápis ochrany selhal — OCO nebyla odeslána")

    response = client.create_oco_order(**request)
    store_protection(ps, response, request)
    state["pending_protection"] = None
    add_event(state, "PROTECTION", f"{symbol} · OCO ochrana aktivní")
    if not save_state(state):
        state["pending_protection"] = request
        save_state(state)
        raise RuntimeError("OCO vznikla, ale její stav se nepodařilo potvrdit")
    return response


def reconcile_pending_protection(client, state):
    request = state.get("pending_protection")
    if not request:
        return state
    symbol = request["symbol"]
    ps = get_pair_state(state, symbol)
    try:
        response = query_protection(client, symbol, request["listClientOrderId"])
    except BinanceAPIException as exc:
        if exc.code != -2013:
            raise
        response = client.create_oco_order(**request)
    store_protection(ps, response, request)
    state["pending_protection"] = None
    if not save_state(state):
        state["pending_protection"] = request
        raise RuntimeError("Obnovenou OCO ochranu se nepodařilo bezpečně uložit")
    log.warning(f"[{symbol}] Obnovena OCO ochrana po restartu")
    return state


def sync_protection(client, state, symbol):
    ps = get_pair_state(state, symbol)
    client_id = ps.get("protection_client_id")
    if not client_id:
        return {"status": "missing"}
    response = query_protection(client, symbol, client_id)
    outcome = protection_outcome(client, symbol, response)
    ps["protection_status"] = outcome["status"].upper()
    return outcome


def close_from_protection(state, symbol, outcome):
    state = record_close(state, symbol, outcome["exit_price"], outcome["reason"])
    if not save_state(state):
        raise RuntimeError("Vyplněnou ochranu se nepodařilo bezpečně uložit")
    return state


def cancel_protection_for_market_exit(client, state, symbol):
    ps = get_pair_state(state, symbol)
    outcome = sync_protection(client, state, symbol)
    if outcome["status"] == "filled":
        close_from_protection(state, symbol, outcome)
        return False
    if outcome["status"] != "active":
        raise RuntimeError("Ochrana není aktivní; market prodej byl zablokován")

    cancel_protection(client, symbol, ps["protection_client_id"])
    outcome = sync_protection(client, state, symbol)
    if outcome["status"] == "filled":
        close_from_protection(state, symbol, outcome)
        return False
    if outcome["status"] != "cancelled":
        raise RuntimeError("Zrušení ochrany nebylo potvrzeno; market prodej byl zablokován")
    clear_protection(ps)
    if not save_state(state):
        raise RuntimeError("Zrušení ochrany se nepodařilo bezpečně uložit")
    return True


def reset_periods(state):
    today = now_utc().strftime("%Y-%m-%d")
    if state["daily_loss_date"] != today:
        state.update(daily_loss=0.0, daily_loss_date=today, trades_today=0)
    wk = now_utc().isocalendar()[1]
    if state["weekly_loss_week"] != wk:
        state.update(weekly_loss=0.0, weekly_loss_week=wk, trades_week=0, trades_week_num=wk)
    return state


def can_trade(state):
    if state.get("entries_paused"):
        return False, "Nové obchody jsou pozastavené uživatelem"
    if state.get("pending_order") or state.get("pending_protection"):
        return False, "Předchozí objednávka čeká na bezpečné ověření"
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
    clear_protection(ps)
    state["last_trade_time"] = now_utc().isoformat()
    add_event(state, "TRADE", f"{symbol} · pozice uzavřena · {pnl:+.2f} {QUOTE_ASSET}")
    return state


def send_daily_summary(state):
    snapshot = state.get("market_snapshot", {})
    lines = []
    for pair in PAIRS:
        symbol = pair["symbol"]
        market = snapshot.get(symbol, {})
        ps = get_pair_state(state, symbol)
        trend = "🟢 BULL" if market.get("bull") is True else \
                "🔴 BEAR" if market.get("bull") is False else "⚪ bez dat"
        if ps["in_position"] and market.get("close"):
            pnl = (market["close"] - ps["entry_price"]) / ps["entry_price"] * 100
            lines.append(f"<b>{symbol}</b>: {trend} | P/L: {pnl:+.2f}%")
        else:
            lines.append(f"<b>{symbol}</b>: {trend} — bez pozice")
    balance = state.get("account_balance")
    balance_text = f"{balance:.2f}" if isinstance(balance, (int, float)) else "—"
    tg(
        f"📊 <b>Denní shrnutí</b> · 20:00\n"
        f"{DIVIDER}\n"
        f"{chr(10).join(lines)}\n"
        f"{DIVIDER}\n"
        f"💰 Balance: <b>{balance_text} {QUOTE_ASSET}</b>\n"
        f"📉 Ztráta týden: {state['weekly_loss']:.2f} {QUOTE_ASSET}"
    )
    mark_daily_summary_sent(state)
    add_event(state, "SUMMARY", "Denní shrnutí odesláno")
    save_state(state)


def maybe_send_daily_summary(state):
    if daily_summary_due(state):
        send_daily_summary(state)


def send_weekly_summary(state):
    snapshot = state.get("market_snapshot", {})
    lines = []
    for pair in PAIRS:
        symbol = pair["symbol"]
        market = snapshot.get(symbol, {})
        ps = get_pair_state(state, symbol)
        trend = "🟢 BULL" if market.get("bull") is True else \
                "🔴 BEAR" if market.get("bull") is False else "⚪ bez dat"
        if ps["in_position"] and market.get("close"):
            pnl = (market["close"] - ps["entry_price"]) / ps["entry_price"] * 100
            trail = " | 🛡️ Trail ON" if ps.get("trail_active") else ""
            lines.append(f"<b>{symbol}</b>: {trend} | V pozici <b>{pnl:+.2f}%</b>{trail}")
        else:
            lines.append(f"<b>{symbol}</b>: {trend} — bez pozice")
    balance = state.get("account_balance")
    balance_text = f"{balance:.2f}" if isinstance(balance, (int, float)) else "—"
    tg(
        f"💓 <b>Týdenní report</b> · neděle 08:00\n"
        f"{DIVIDER}\n"
        f"{chr(10).join(lines)}\n"
        f"{DIVIDER}\n"
        f"💰 Balance: <b>{balance_text} {QUOTE_ASSET}</b>\n"
        f"📉 Ztráta týden: {state['weekly_loss']:.2f} {QUOTE_ASSET}\n"
        f"🤖 Bot běží normálně ✅"
    )
    mark_weekly_summary_sent(state)
    add_event(state, "SUMMARY", "Týdenní report odeslán")
    save_state(state)


def maybe_send_weekly_summary(state):
    if weekly_summary_due(state):
        send_weekly_summary(state)


def maybe_send_scheduled_summaries(state):
    maybe_send_daily_summary(state)
    maybe_send_weekly_summary(state)


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
    deadline = time.monotonic() + wait
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        maybe_send_scheduled_summaries(state)
        time.sleep(min(60, remaining))


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
        protection_filters = {}
        for pair in PAIRS:
            sym = pair["symbol"]
            step_size, tick_size, min_notional = get_symbol_filters(client, sym)
            pair_filters[sym] = (step_size, tick_size, min_notional)
            protection_filters[sym] = trailing_delta_filter(client.get_symbol_info(sym))
            log.info(f"[{sym}] step={step_size} | tick={tick_size} | minNotional={min_notional}")
    except Exception as e:
        log.error(f"Chyba při inicializaci párů: {e}")
        tg(f"❌ <b>Bot se nespustil!</b>\n{e}")
        raise SystemExit(1)

    state = load_state()
    state = reconcile_pending_order(client, state)
    state = reconcile_pending_protection(client, state)
    save_state(state)

    balance = get_balance(client, QUOTE_ASSET, raise_on_error=True)
    state.update(account_balance=balance, quote_asset=QUOTE_ASSET)
    save_state(state)
    tg(
        f"🚀 <b>Bot spuštěn</b>\n"
        f"{DIVIDER}\n"
        f"📊 Strategie: Golden Cross EMA{EMA_FAST_PERIOD}/EMA{EMA_SLOW_PERIOD} (4h)\n"
        f"💱 Páry: {' | '.join(symbols)}\n"
        f"💰 Balance: <b>{balance:.2f} {QUOTE_ASSET}</b>\n"
        f"🛡️ SL: -{MAX_SL_PCT}% | Trail: +{TRAIL_ACTIVATE_PCT}% → -{TRAIL_DISTANCE_PCT}%\n"
        f"⚙️ Režim: {mode}"
    )

    while True:
        cycle_errors = []
        state = refresh_entries_control(state)
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
                        if not ps.get("protection_client_id"):
                            request = protection_request(
                                symbol, ps, get_balance(client, base, raise_on_error=True),
                                step_size, tick_size, protection_filters[symbol]
                            )
                            place_protection(client, state, symbol, request)
                            log.info(f"[{symbol}] Burzovní OCO ochrana aktivována")

                        protection = sync_protection(client, state, symbol)
                        if protection["status"] == "filled":
                            state = close_from_protection(state, symbol, protection)
                            continue
                        if protection["status"] in ("cancelled", "failed"):
                            clear_protection(ps)
                            if not save_state(state):
                                raise RuntimeError("Zrušenou ochranu se nepodařilo bezpečně uložit")
                            request = protection_request(
                                symbol, ps, get_balance(client, base, raise_on_error=True),
                                step_size, tick_size, protection_filters[symbol]
                            )
                            place_protection(client, state, symbol, request)
                            protection = sync_protection(client, state, symbol)
                        if protection["status"] != "active":
                            raise RuntimeError("Pozice nemá aktivní burzovní ochranu")

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
                            if cancel_protection_for_market_exit(client, state, symbol):
                                ep    = sell_market(client, ps, symbol, step_size)
                                state = record_close(state, symbol, ep, "DEATH_CROSS")
                                save_state(state)

                    # ── BEZ POZICE ────────────────────────────────────────────
                    else:
                        if data["golden_cross"]:
                            state = refresh_entries_control(state)
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
                                    intent = new_buy_intent(symbol, spend)
                                    state["pending_order"] = intent
                                    if not save_state(state):
                                        state["pending_order"] = None
                                        save_state(state)
                                        raise RuntimeError("Bezpečný zápis objednávky selhal — nákup zablokován")

                                    order       = client.order_market_buy(
                                        symbol=symbol,
                                        quoteOrderQty=str(round(spend, 2)),
                                        newClientOrderId=intent["client_order_id"],
                                    )
                                    ps = apply_filled_buy(state, intent, order)
                                    qty_filled = ps["position_qty"]
                                    entry_price = ps["entry_price"]

                                    if not save_state(state):
                                        state["pending_order"] = intent
                                        save_state(state)
                                        raise RuntimeError("Nákup proběhl, ale stav se nepodařilo potvrdit")

                                    request = protection_request(
                                        symbol, ps, get_balance(client, base, raise_on_error=True),
                                        step_size, tick_size, protection_filters[symbol]
                                    )
                                    place_protection(client, state, symbol, request)
                                    add_event(state, "TRADE", f"{symbol} · pozice otevřena @ {entry_price:.2f}")
                                    save_state(state)

                                    log.info(f"[{symbol}] Nakoupeno a chráněno: {qty_filled} {base} @ {entry_price:.2f}")
                                    tg(
                                        f"⚡ <b>GOLDEN CROSS — {symbol}</b>\n"
                                        f"{DIVIDER}\n"
                                        f"💵 Nakoupeno: <b>{qty_filled} {base}</b>\n"
                                        f"📈 Cena vstupu: <b>{entry_price:.2f} {QUOTE_ASSET}</b>\n"
                                        f"🎯 Strategie: drž do Death Cross\n"
                                        f"🛡️ Nouzový SL: {entry_price * (1 - MAX_SL_PCT / 100):.2f} | "
                                        f"Trail aktivace: +{TRAIL_ACTIVATE_PCT}%"
                                    )
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
            state.update(account_balance=balance, quote_asset=QUOTE_ASSET)
            state["market_snapshot"] = {
                symbol: {"close": data["close"], "bull": data["bull"]}
                for symbol, data in pair_data.items()
            }
            add_event(state, "MARKET", "Trh zkontrolován")
            log.info(
                f"Balance: {balance:.2f} {QUOTE_ASSET} | "
                f"Ztráty: den={state['daily_loss']:.2f} týden={state['weekly_loss']:.2f}"
            )

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
