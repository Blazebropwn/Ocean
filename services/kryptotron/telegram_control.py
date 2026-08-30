from datetime import datetime, timedelta, timezone


DIVIDER = "─" * 20
CONFIRM_TTL_MINUTES = 5


def _on(value):
    return "zapnuto" if value else "vypnuto"


def status_message(state, quote_asset="USDC"):
    balance = state.get("account_balance")
    balance_text = f"{balance:.2f} {quote_asset}" if isinstance(balance, (int, float)) else "—"
    streak = state.get("streak", {})
    session = streak.get("session", {})
    return (
        "🌊 <b>Ocean · stav</b>\n"
        f"{DIVIDER}\n"
        f"🤖 Trading: <b>{'pozastaven' if state.get('entries_paused') else 'aktivní'}</b>\n"
        f"🌱 DCA: <b>{_on(state.get('dca', {}).get('enabled', False))}</b>\n"
        f"🎯 Streak: <b>{_on(streak.get('enabled', False))}</b> · PAPER\n"
        f"💰 Balance: <b>{balance_text}</b>\n"
        f"🔥 Dnešní série: <b>{session.get('streak', 0)} výher</b>"
    )


def help_message():
    return (
        "🌊 <b>Ocean · ovládání</b>\n"
        f"{DIVIDER}\n"
        "/status — aktuální stav\n"
        "/report — stručný přehled\n"
        "/pause · /resume — nové obchody\n"
        "/dca · /dca_on · /dca_off\n"
        "/streak · /streak_on · /streak_off"
    )


def report_message(state, quote_asset="USDC"):
    lines = []
    for symbol, market in state.get("market_snapshot", {}).items():
        trend = "🟢 BULL" if market.get("bull") is True else "🔴 BEAR" if market.get("bull") is False else "⚪ —"
        lines.append(f"{symbol}: {trend}")
    balance = state.get("account_balance")
    balance_text = f"{balance:.2f}" if isinstance(balance, (int, float)) else "—"
    return (
        "📊 <b>Ocean · přehled</b>\n"
        f"{DIVIDER}\n"
        f"{chr(10).join(lines) if lines else 'Tržní data zatím nejsou dostupná.'}\n"
        f"{DIVIDER}\n"
        f"💰 {balance_text} {quote_asset}\n"
        f"📉 Týdenní ztráta: {state.get('weekly_loss', 0):.2f} {quote_asset}"
    )


def confirmation(action, now=None):
    labels = {"resume": "obnovit nové obchody", "dca_on": "zapnout DCA", "streak_on": "zapnout PAPER Streak"}
    current = now or datetime.now(timezone.utc)
    return {
        "action": action,
        "expires_at": (current + timedelta(minutes=CONFIRM_TTL_MINUTES)).isoformat(),
        "message": f"Potvrdit: <b>{labels[action]}</b>?",
        "keyboard": {"inline_keyboard": [[
            {"text": "Potvrdit", "callback_data": f"confirm:{action}"},
            {"text": "Zrušit", "callback_data": "confirm:cancel"},
        ]]},
    }


def confirmation_valid(pending, action, now=None):
    if not isinstance(pending, dict) or pending.get("action") != action:
        return False
    try:
        expires = datetime.fromisoformat(pending["expires_at"])
    except (KeyError, TypeError, ValueError):
        return False
    return (now or datetime.now(timezone.utc)) <= expires


def apply_action(state, action):
    if action == "pause":
        state["entries_paused"] = True
        return "⏸ Nové obchody byly pozastaveny. Otevřené pozice zůstávají chráněné."
    if action == "resume":
        state["entries_paused"] = False
        return "▶️ Nové obchody byly obnoveny."
    if action in {"dca_on", "dca_off"}:
        enabled = action.endswith("_on")
        state.setdefault("dca", {})["enabled"] = enabled
        return f"🌱 DCA je nyní <b>{_on(enabled)}</b>."
    if action in {"streak_on", "streak_off"}:
        enabled = action.endswith("_on")
        state.setdefault("streak", {})["enabled"] = enabled
        return f"🎯 PAPER Streak je nyní <b>{_on(enabled)}</b>."
    raise ValueError("Neznámá Telegram akce")
