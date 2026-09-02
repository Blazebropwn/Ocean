"""
Supabase persistence layer.
Falls back silently if SUPABASE_URL / SUPABASE_KEY are not set.
"""

import os
import logging
import requests
from datetime import datetime, timezone
from config.settings import INSTANCE_ID

log = logging.getLogger(__name__)
_sb = None
_broker_url = ""
_broker_headers = {}


def init():
    global _sb, _broker_url, _broker_headers
    broker_url = os.environ.get("OCEAN_STATE_URL", "").rstrip("/")
    broker_token = os.environ.get("OCEAN_STATE_TOKEN", "")
    if broker_url and broker_token:
        _broker_url = broker_url
        _broker_headers = {
            "Authorization": f"Bearer {broker_token}",
            "X-Ocean-Instance": INSTANCE_ID,
        }
        log.info("Ocean state broker připojen ✓")
        return
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
    if _broker_url:
        try:
            response = requests.get(f"{_broker_url}/state", headers=_broker_headers, timeout=8)
            if response.status_code == 404:
                return None
            response.raise_for_status()
            return response.json().get("state")
        except Exception as e:
            log.error(f"Ocean load_state chyba: {e}")
            return None
    if _sb is None:
        return None
    try:
        res = _sb.table("bot_state").select("data").eq("key", INSTANCE_ID).execute()
        if res.data:
            return res.data[0]["data"]
    except Exception as e:
        log.error(f"Supabase load_state chyba: {e}")
    return None


def save_state(state):
    if _broker_url:
        try:
            response = requests.put(f"{_broker_url}/state", headers=_broker_headers, json={"state": state}, timeout=8)
            response.raise_for_status()
            return True
        except Exception as e:
            log.error(f"Ocean save_state chyba: {e}")
            return False
    if _sb is None:
        return False
    try:
        _sb.table("bot_state").upsert({
            "key": INSTANCE_ID,
            "data": state,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }).execute()
        return True
    except Exception as e:
        log.error(f"Supabase save_state chyba: {e}")
        return False


def log_trade(symbol, entry_price, exit_price, qty, pnl, result, reason=None, entry_time=None):
    payload = {
        "symbol": symbol,
        "entry_price": float(entry_price),
        "exit_price": float(exit_price),
        "qty": float(qty),
        "pnl": float(pnl),
        "result": result,
        "reason": reason,
        "entry_time": entry_time,
    }
    if _broker_url:
        try:
            response = requests.post(f"{_broker_url}/trades", headers=_broker_headers, json=payload, timeout=8)
            response.raise_for_status()
        except Exception as e:
            log.error(f"Ocean log_trade chyba: {e}")
        return
    if _sb is None:
        return
    try:
        _sb.table("bot_trades").insert({"instance_id": INSTANCE_ID, **payload}).execute()
    except Exception as e:
        log.error(f"Supabase log_trade chyba: {e}")
