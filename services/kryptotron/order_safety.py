from datetime import datetime, timezone
from uuid import uuid4
import math


TERMINAL_FAILURES = {"CANCELED", "REJECTED", "EXPIRED", "EXPIRED_IN_MATCH"}


def with_execution_fills(client, symbol, order):
    """Order queries omit commissions. Recover fills by exchange order ID."""
    if "fills" in order or float(order.get("executedQty", 0)) <= 0:
        return order
    if order.get("orderId") is None:
        raise RuntimeError("Chybí burzovní ID plnění")
    fills = client.get_my_trades(symbol=symbol, orderId=order["orderId"], limit=1000)
    if not isinstance(fills, list) or not fills:
        raise RuntimeError("Burza zatím nepotvrdila jednotlivá plnění")
    total = sum(float(fill["qty"]) for fill in fills)
    if not math.isclose(total, float(order["executedQty"]), rel_tol=1e-8, abs_tol=1e-12):
        raise RuntimeError("Seznam plnění neodpovídá množství objednávky")
    return {**order, "fills": fills}


def new_buy_intent(symbol, quote_amount):
    return {
        "client_order_id": f"ocean-buy-{symbol.lower()}-{uuid4().hex[:12]}",
        "symbol": symbol,
        "side": "BUY",
        "quote_amount": float(quote_amount),
        "created_at": datetime.now(timezone.utc).isoformat(),
    }


def apply_filled_buy(state, intent, order):
    if order.get("status") != "FILLED" and order.get("status") not in TERMINAL_FAILURES:
        raise ValueError("Objednávka ještě není kompletně vyplněná")
    quantity = float(order.get("executedQty", 0))
    quote_spent = float(order.get("cummulativeQuoteQty", 0))
    if not all(math.isfinite(v) and v > 0 for v in (quantity, quote_spent)):
        raise ValueError("Binance nevrátila platné vyplnění objednávky")

    symbol = intent["symbol"]
    base = symbol.removesuffix("USDC")
    fees = {}
    for fill in order.get("fills", []):
        asset = fill.get("commissionAsset")
        commission = float(fill.get("commission", 0))
        if not math.isfinite(commission) or commission < 0:
            raise ValueError("Neplatný poplatek burzovního plnění")
        if asset:
            fees[asset] = fees.get(asset, 0) + commission
    net_quantity = quantity - fees.get(base, 0)
    if net_quantity <= 0:
        raise ValueError("Čisté množství nákupu není kladné")
    position = state["positions"].setdefault(symbol, {})
    client_order_id = intent["client_order_id"]
    already_applied = position.get("entry_order_client_id") == client_order_id
    if position.get("in_position") and not already_applied:
        raise RuntimeError("Jiný vstup už má otevřenou pozici; nové plnění vyžaduje kontrolu")
    if not already_applied:
        entry_price = quote_spent / quantity
        position.update(
            in_position=True,
            position_qty=net_quantity,
            entry_gross_qty=quantity,
            entry_net_qty=net_quantity,
            entry_quote_spent=quote_spent,
            entry_fees=fees,
            entry_fees_known="fills" in order,
            entry_price=entry_price,
            entry_time=intent["created_at"],
            entry_order_id=order.get("orderId"),
            entry_order_client_id=client_order_id,
            highest_price=entry_price,
            trail_active=False,
            trail_sl=0.0,
            pre_cross_alerted="",
        )
        state["last_trade_time"] = intent["created_at"]
        state["trades_today"] += 1
        state["trades_week"] += 1
    state["pending_order"] = None
    return position


def classify_order(order):
    status = str(order.get("status", ""))
    quantity = float(order.get("executedQty", 0))
    if not math.isfinite(quantity) or quantity < 0:
        raise ValueError("Burza nevrátila platné vyplněné množství")
    if status != "FILLED" and quantity > 0:
        return "settled_partial" if status in TERMINAL_FAILURES else "partial"
    if status == "FILLED":
        return "filled"
    if status in TERMINAL_FAILURES:
        return "failed"
    return "pending"
