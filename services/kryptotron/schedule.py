from datetime import datetime, timezone
from zoneinfo import ZoneInfo


PRAGUE = ZoneInfo("Europe/Prague")


def daily_summary_due(state, now=None):
    current = (now or datetime.now(timezone.utc)).astimezone(PRAGUE)
    return current.hour >= 20 and state.get("last_daily_summary_date") != current.date().isoformat()


def mark_daily_summary_sent(state, now=None):
    current = (now or datetime.now(timezone.utc)).astimezone(PRAGUE)
    state["last_daily_summary_date"] = current.date().isoformat()
    return state
