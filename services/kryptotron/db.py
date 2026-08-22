"""
Supabase persistence layer.
Falls back silently if SUPABASE_URL / SUPABASE_KEY are not set.
"""

import os
import logging
from datetime import datetime, timezone

log = logging.getLogger(__name__)
_sb = None


def init():
    global _sb
    url = os.environ.get("SUPABASE_URL", "")
    key = os.environ.get("SUPABASE_KEY", "")
    if not url or not key:
        log.warning("SUPABASE_URL/SUPABASE_KEY není nastaven — state se ukládá pouze lokálně")
        return
    try:
        from supabase import create_client
        _sb = create_client(url, key)
        log.info("Supabase připojen ✓")
    except Exception as e:
        log.error(f"Supabase init selhalo: {e}")


def load_state():
    if _sb is None:
        return None
    try:
        res = _sb.table("bot_state").select("data").eq("key", "main").execute()
        if res.data:
            return res.data[0]["data"]
    except Exception as e:
        log.error(f"Supabase load_state chyba: {e}")
    return None


def save_state(state):
    if _sb is None:
        return False
    try:
        _sb.table("bot_state").upsert({
            "key": "main",
            "data": state,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }).execute()
        return True
    except Exception as e:
        log.error(f"Supabase save_state chyba: {e}")
        return False


def log_trade(symbol, entry_price, exit_price, qty, pnl, result, reason=None, entry_time=None):
    if _sb is None:
        return
    try:
        _sb.table("bot_trades").insert({
            "symbol": symbol,
            "entry_price": float(entry_price),
            "exit_price": float(exit_price),
            "qty": float(qty),
            "pnl": float(pnl),
            "result": result,
            "reason": reason,
            "entry_time": entry_time,
        }).execute()
    except Exception as e:
        log.error(f"Supabase log_trade chyba: {e}")
