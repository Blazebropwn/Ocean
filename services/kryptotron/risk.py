"""Deterministic entry rules shared by the worker and production-model research.

No exchange access and no clock reads: callers supply the observation time.
"""
from datetime import datetime
import math

from config import settings
from manual_close import active_request


def entry_permission(state, now, *, require_reconciliation=True, symbol=None):
    if state.get("api_permissions_safe") is False:
        return "RECONCILIATION_REQUIRED", "Oprávnění API klíče nejsou bezpečně ověřená."
    if state.get("pending_trade_logs"):
        return "PERSISTENCE_REQUIRED", "Potvrzený obchod čeká na uložení do historie."
    if state.get("safe_mode"):
        return "RECONCILIATION_REQUIRED", "Stav účtu vyžaduje ověření. Nové nákupy jsou zablokované."
    if state.get("entries_paused", True):
        return "ENTRIES_PAUSED", "Nové obchody jsou pozastavené uživatelem."
    if active_request(state):
        return "MANUAL_CLOSE_PENDING", "Ruční uzavření čeká na potvrzení burzou."
    if symbol and state.get("pair_cooldowns", {}).get(symbol):
        try:
            until = datetime.fromisoformat(state["pair_cooldowns"][symbol])
            if now < until:
                return "PAIR_COOLDOWN", "Po ručním uzavření běží hodinová pauza pro tento pár."
        except (TypeError, ValueError):
            return "STALE_STATE", "Čas přestávky není platný."
    if state.get("pending_order") or state.get("pending_protection") or state.get("dca", {}).get("pending"):
        return "RECONCILIATION_REQUIRED", "Předchozí objednávka čeká na ověření na burze."
    if require_reconciliation:
        check = state.get("reconciliation", {})
        if check.get("status") != "OK":
            return "RECONCILIATION_REQUIRED", "Soulad účtu s burzou zatím není potvrzený."
        try:
            age = (now - datetime.fromisoformat(check["checked_at"])).total_seconds()
        except (KeyError, TypeError, ValueError):
            age = float("inf")
        if not 0 <= age <= 90:
            return "STALE_STATE", "Ověření účtu je zastaralé. Čekám na čerstvá data."
    for field, limit, code, message in (
        ("daily_loss", settings.MAX_DAILY_LOSS_USDT, "DAILY_LOSS_LIMIT", "Byl dosažen denní limit ztráty."),
        ("weekly_loss", settings.MAX_WEEKLY_LOSS_USDT, "WEEKLY_LOSS_LIMIT", "Byl dosažen týdenní limit ztráty."),
        ("trades_today", settings.MAX_TRADES_PER_DAY, "DAILY_TRADE_LIMIT", "Byl dosažen denní limit vstupů."),
        ("trades_week", settings.MAX_TRADES_PER_WEEK, "WEEKLY_TRADE_LIMIT", "Byl dosažen týdenní limit vstupů."),
    ):
        value = state.get(field, 0)
        if not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
            return "STALE_STATE", "Evidence rizikových limitů není platná."
        if value >= limit:
            return code, message
    if state.get("last_trade_time"):
        try:
            elapsed = (now - datetime.fromisoformat(state["last_trade_time"])).total_seconds() / 3600
        except (TypeError, ValueError):
            return "STALE_STATE", "Čas posledního obchodu není platný."
        if elapsed < 0:
            return "STALE_STATE", "Čas posledního obchodu je v budoucnosti."
        if state.get("consecutive_losses", 0) >= settings.MAX_CONSECUTIVE_LOSSES and elapsed < settings.COOLDOWN_AFTER_LOSS_HRS:
            return "COOLDOWN_ACTIVE", "Po sérii ztrát běží ochranná přestávka."
        if state.get("last_trade_result") == "WIN" and state.get("last_trade_reason") != "MANUAL_CLOSE" and elapsed < settings.COOLDOWN_AFTER_WIN_HRS:
            return "COOLDOWN_ACTIVE", "Po ziskovém obchodu běží přestávka."
    return "ENTRY_ALLOWED", "Býčí režim a dostupný rizikový rozpočet dovolují vstup."


def position_budget(free_quote):
    if not isinstance(free_quote, (int, float)) or not math.isfinite(free_quote) or free_quote < 0:
        raise ValueError("Neplatný dostupný zůstatek")
    return min(free_quote * settings.POSITION_PCT / 100, settings.MAX_POSITION_USDT)


def decision_snapshot(state, symbol, data, now, *, minimum=0, free_quote=None):
    position = state.get("positions", {}).get(symbol, {})
    code, reason = entry_permission(state, now, symbol=symbol)
    decision = "NO_ENTRY"
    if position.get("in_position"):
        if state.get("safe_mode"):
            code, reason = "RECONCILIATION_REQUIRED", "Pozice vyžaduje ověření proti burze."
            decision = "REVIEW"
        elif position.get("protection_status") != "ACTIVE":
            code, reason = "PROTECTION_ERROR", "Burzovní ochrana pozice není potvrzená."
            decision = "REVIEW"
        elif data["death_cross"]:
            code, reason = "DEATH_CROSS", "EMA50 překročila EMA200 směrem dolů; pravidlo požaduje výstup."
            decision = "EXIT_REQUIRED"
        else:
            code, reason = "POSITION_ALREADY_OPEN", "Pozice je otevřená a má potvrzenou burzovní ochranu."
            decision = "HOLD"
    elif code == "ENTRY_ALLOWED":
        if not data["bull"]:
            code, reason = "BEAR_REGIME", "EMA50 není nad EMA200. Strategie čeká na býčí režim."
        elif free_quote is None:
            code, reason = "STALE_STATE", "Dostupný zůstatek nebyl ověřený."
        elif position_budget(free_quote) < minimum:
            code, reason = "INSUFFICIENT_BALANCE", "Povolená částka nedosahuje minima objednávky."
        else:
            decision = "ENTRY_ALLOWED"
    return {
        "symbol": symbol, "checkedAt": now.isoformat(),
        "marketRegime": "BULL" if data["bull"] else "BEAR",
        "price": data["close"], "emaFast": data["ema_fast"], "emaSlow": data["ema_slow"],
        "positionState": "OPEN" if position.get("in_position") else "FLAT",
        "decision": decision, "reasonCode": code, "reason": reason,
        "nextCheckAt": state.get("next_check_at"),
        "risk": {"maxOrderQuote": settings.MAX_POSITION_USDT,
                 "availableQuote": free_quote, "positionPct": settings.POSITION_PCT,
                 "stopLossPct": settings.MAX_SL_PCT,
                 "dailyLoss": state.get("daily_loss", 0), "dailyLossLimit": settings.MAX_DAILY_LOSS_USDT,
                 "weeklyLoss": state.get("weekly_loss", 0), "weeklyLossLimit": settings.MAX_WEEKLY_LOSS_USDT},
    }
