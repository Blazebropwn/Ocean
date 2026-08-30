# utils.py
import math
import logging
import requests
import pandas as pd

log = logging.getLogger(__name__)


def get_klines(client, symbol, interval, limit=300):
    klines = client.get_klines(symbol=symbol, interval=interval, limit=limit)
    closes = [float(k[4]) for k in klines]
    opens  = [float(k[1]) for k in klines]
    return closes, opens


def calculate_ema(closes, period):
    return pd.Series(closes).ewm(span=period, adjust=False).mean().tolist()


def calculate_rsi(closes, period=14):
    s     = pd.Series(closes)
    delta = s.diff()
    gain  = delta.clip(lower=0)
    loss  = (-delta).clip(lower=0)
    avg_g = gain.ewm(com=period - 1, min_periods=period).mean()
    avg_l = loss.ewm(com=period - 1, min_periods=period).mean()
    rs    = avg_g / avg_l
    return (100 - 100 / (1 + rs)).tolist()


def get_balance(client, asset="USDT", raise_on_error=False):
    try:
        b = client.get_asset_balance(asset=asset)
        return float(b["free"]) if b else 0.0
    except Exception as e:
        log.error(f"get_balance chyba ({asset}): {e}")
        if raise_on_error:
            raise
        return 0.0


def get_symbol_filters(client, symbol):
    info         = client.get_symbol_info(symbol)
    if info is None:
        raise ValueError(f"Symbol {symbol} neexistuje na této burze (špatná síť nebo pár?)")
    step_size    = 0.00001
    tick_size    = 0.01
    min_notional = 5.0
    for f in info["filters"]:
        ft = f["filterType"]
        if ft == "LOT_SIZE":
            step_size = float(f["stepSize"])
        elif ft == "PRICE_FILTER":
            tick_size = float(f["tickSize"])
        elif ft in ("MIN_NOTIONAL", "NOTIONAL"):
            min_notional = float(f.get("minNotional", f.get("notional", 5.0)))
    return step_size, tick_size, min_notional


def _precision(v):
    if v >= 1:
        return 0
    return int(round(-math.log10(v), 0))


def round_step(qty, step_size):
    p = _precision(step_size)
    return round(math.floor(qty / step_size) * step_size, p)


def round_price(price, tick_size):
    p = _precision(tick_size)
    return round(math.floor(price / tick_size) * tick_size, p)


def notify(token, chat_id, message, reply_markup=None):
    """Pošle zprávu na Telegram. Selže tiše — nikdy nezastaví bota."""
    if not token or not chat_id:
        return
    try:
        payload = {"chat_id": chat_id, "text": message, "parse_mode": "HTML"}
        if reply_markup:
            payload["reply_markup"] = reply_markup
        response = requests.post(
            f"https://api.telegram.org/bot{token}/sendMessage",
            json=payload,
            timeout=10,
        )
        response.raise_for_status()
        return True
    except Exception as ex:
        log.warning(f"Telegram notifikace selhala: {ex}")
        return False


def telegram_updates(token, offset=None):
    """Načte nové příkazy bez dlouhého blokování workeru."""
    if not token:
        return []
    payload = {"timeout": 0, "allowed_updates": ["message", "callback_query"]}
    if offset is not None:
        payload["offset"] = offset
    response = requests.post(
        f"https://api.telegram.org/bot{token}/getUpdates",
        json=payload,
        timeout=10,
    )
    response.raise_for_status()
    body = response.json()
    return body.get("result", []) if body.get("ok") else []


def answer_telegram_callback(token, callback_query_id, text):
    if not token or not callback_query_id:
        return
    try:
        requests.post(
            f"https://api.telegram.org/bot{token}/answerCallbackQuery",
            json={"callback_query_id": callback_query_id, "text": text},
            timeout=10,
        ).raise_for_status()
    except Exception as ex:
        log.warning(f"Telegram callback selhal: {ex}")
