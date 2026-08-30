from datetime import datetime, timezone
from zoneinfo import ZoneInfo


PRAGUE = ZoneInfo("Europe/Prague")
FLAT_TOLERANCE = 0.05


def session_date(now=None):
    return (now or datetime.now(timezone.utc)).astimezone(PRAGUE).date().isoformat()


def new_session(now=None):
    return {
        "date": session_date(now), "status": "READY", "streak": 0,
        "trades": 0, "wins": 0, "losses": 0, "gross_pnl": 0.0,
        "fees": 0.0, "net_pnl": 0.0, "locked_at": None,
        "lock_reason": None, "history": [],
    }


def ensure_session(streak, now=None):
    current = streak.get("session")
    if not isinstance(current, dict) or current.get("date") != session_date(now):
        if isinstance(current, dict):
            history = streak.setdefault("sessions", [])
            history.append(current)
            streak["sessions"] = history[-90:]
        streak["session"] = new_session(now)
    return streak["session"]


def can_trade(streak, now=None):
    if not streak.get("enabled", False):
        return False, "DISABLED"
    session = ensure_session(streak, now)
    if session["status"] != "READY":
        return False, session["lock_reason"] or session["status"]
    return True, "READY"


def open_trade(streak, candidate, now=None):
    allowed, reason = can_trade(streak, now)
    if not allowed:
        raise RuntimeError(f"Streak session nepovoluje obchod: {reason}")
    session = streak["session"]
    session["status"] = "IN_POSITION"
    session["open_trade"] = candidate
    return session


def close_trade(streak, gross_pnl, fees=0.0, slippage=0.0, now=None):
    session = ensure_session(streak, now)
    if session["status"] != "IN_POSITION":
        raise RuntimeError("Streak session nemá otevřený obchod")
    net_pnl = float(gross_pnl) - float(fees) - float(slippage)
    result = "WIN" if net_pnl > FLAT_TOLERANCE else "LOSS" if net_pnl < -FLAT_TOLERANCE else "FLAT"
    session["trades"] += 1
    session["gross_pnl"] += float(gross_pnl)
    session["fees"] += float(fees) + float(slippage)
    session["net_pnl"] += net_pnl
    record = {"result": result, "gross_pnl": float(gross_pnl), "fees": float(fees), "slippage": float(slippage), "net_pnl": net_pnl, "at": (now or datetime.now(timezone.utc)).isoformat()}
    session.setdefault("history", []).append(record)
    session.pop("open_trade", None)
    if result == "WIN":
        session["wins"] += 1
        session["streak"] += 1
        session["status"] = "READY"
    elif result == "LOSS":
        session["losses"] += 1
        session["status"] = "LOCKED"
        session["locked_at"] = record["at"]
        session["lock_reason"] = "FIRST_LOSS"
    else:
        session["status"] = "READY"
    return record


def emergency_lock(streak, reason, now=None):
    session = ensure_session(streak, now)
    session["status"] = "EMERGENCY_LOCK"
    session["locked_at"] = (now or datetime.now(timezone.utc)).isoformat()
    session["lock_reason"] = reason
    return session
