# utils.py
import math
import logging
import requests
import pandas as pd
from datetime import datetime, timezone

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


def refresh_account_balance(client, state, quote_asset="USDC"):
    """Refresh spendable Spot funds independently of the trading schedule.

    Preserve the last successful value and its timestamp on failure so the UI
    can mark it as stale instead of showing a fabricated zero or fresh balance.
    """
    try:
        amount = get_balance(client, quote_asset, raise_on_error=True)
        if not math.isfinite(amount) or amount < 0:
            raise ValueError("Invalid balance")
    except Exception:
        state["account_balance_error"] = "Zůstatek se nepodařilo obnovit"
        return False
    state.update(
        account_balance=amount,
        account_balance_at=datetime.now(timezone.utc).isoformat(),
        account_balance_error=None,
        quote_asset=quote_asset,
    )
    return True


def read_portfolio_snapshot(client, quote_asset="USDC"):
    """Return a bounded, credential-free portfolio view safe to persist in Ocean state."""
    account = client.get_account()
    prices = {}
    for ticker in client.get_all_tickers():
        symbol = ticker.get("symbol")
        try:
            price = float(ticker.get("price", 0))
        except (TypeError, ValueError):
            continue
        if isinstance(symbol, str) and math.isfinite(price) and price >= 0:
            prices[symbol] = price

    assets = []
    for balance in account.get("balances", []):
        asset = balance.get("asset")
        if not isinstance(asset, str) or not asset.isalnum() or not 2 <= len(asset) <= 16:
            continue
        try:
            quantity = float(balance.get("free", 0)) + float(balance.get("locked", 0))
        except (TypeError, ValueError):
            continue
        if not math.isfinite(quantity) or quantity <= 0:
            continue
        price = 1.0 if asset == quote_asset else prices.get(f"{asset}{quote_asset}")
        assets.append({"asset": asset, "quantity": quantity, "price_usdc": price})

    return {
        "schema_version": "ocean.worker-portfolio.v1",
        "captured_at": datetime.now(timezone.utc).isoformat(),
        "quote_currency": quote_asset,
        "assets": assets[:2000],
    }


def portfolio_snapshot_due(state, now=None, max_age_seconds=600):
    """Return True when the persisted portfolio view should be refreshed."""
    current = now or datetime.now(timezone.utc)
    captured_at = state.get("portfolio_snapshot", {}).get("captured_at")
    if not isinstance(captured_at, str):
        return True
    try:
        captured = datetime.fromisoformat(captured_at.replace("Z", "+00:00"))
    except ValueError:
        return True
    if captured.tzinfo is None:
        return True
    age_seconds = (current - captured.astimezone(timezone.utc)).total_seconds()
    return age_seconds < 0 or age_seconds >= max_age_seconds


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
