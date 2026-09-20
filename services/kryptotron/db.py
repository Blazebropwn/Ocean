"""Instance-scoped Ocean state and notification broker."""

import os
import logging
import requests
import re
from uuid import uuid4
from config.settings import INSTANCE_ID

log = logging.getLogger(__name__)
_broker_url = ""
_broker_headers = {}


def notify(message):
    """Queue a notification through Ocean; no Telegram token in any worker."""
    if not _broker_url:
        log.warning("Notifikaci nelze odeslat bez Ocean brokeru")
        return False
    payload = {"id": uuid4().hex, "message": message}
    # Reuse the ID on an ambiguous timeout so a retry cannot enqueue twice.
    for _ in range(2):
        try:
            response = requests.post(f"{_broker_url}/notifications", headers=_broker_headers,
                                     json=payload, timeout=8)
            response.raise_for_status()
            return True
        except requests.RequestException:
            pass
    log.warning("Ocean notifikaci nepřijal")
    return False


def init():
    global _broker_url, _broker_headers
    broker_url = os.environ.get("OCEAN_STATE_URL", "").rstrip("/")
    broker_token = os.environ.get("OCEAN_STATE_TOKEN", "")
    if not re.fullmatch(r"kry_[a-f0-9]{32}", INSTANCE_ID):
        raise RuntimeError("Kryptotron vyžaduje ID osobní instance Oceanu")
    if broker_url and broker_token:
        _broker_url = broker_url
        _broker_headers = {
            "Authorization": f"Bearer {broker_token}",
            "X-Ocean-Instance": INSTANCE_ID,
        }
        log.info("Ocean state broker připojen ✓")
        return
    raise RuntimeError("Kryptotron musí spouštět Ocean s vlastním state broker tokenem")


def load_state():
    if _broker_url:
        try:
            response = requests.get(f"{_broker_url}/state", headers=_broker_headers, timeout=8)
            response.raise_for_status()
            state = response.json().get("state")
            if not isinstance(state, dict):
                raise RuntimeError("Ocean vrátil neplatný stav")
            return state
        except Exception as e:
            raise RuntimeError("Stav z Ocean brokeru není dostupný") from e
    raise RuntimeError("Ocean broker není nakonfigurovaný")


def save_state(state):
    if _broker_url:
        try:
            response = requests.put(f"{_broker_url}/state", headers=_broker_headers, json={"state": state}, timeout=8)
            response.raise_for_status()
            return True
        except Exception as e:
            log.error(f"Ocean save_state chyba: {e}")
            return False
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
