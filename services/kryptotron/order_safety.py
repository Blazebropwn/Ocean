from datetime import datetime, timezone
from uuid import uuid4


TERMINAL_FAILURES = {"CANCELED", "REJECTED", "EXPIRED", "EXPIRED_IN_MATCH"}


def new_buy_intent(symbol, quote_amount):
    return {
        "client_order_id": f"ocean-buy-{symbol.lower()}-{uuid4().hex[:12]}",
        "symbol": symbol,
        "side": "BUY",
        "quote_amount": float(quote_amount),
        "created_at": datetime.now(timezone.utc).isoformat(),
    }


def apply_filled_buy(state, intent, order):
    if order.get("status") != "FILLED":
        raise ValueError("Objednávka ještě není kompletně vyplněná")
    quantity = float(order.get("executedQty", 0))
    quote_spent = float(order.get("cummulativeQuoteQty", 0))
    if quantity <= 0 or quote_spent <= 0:
        raise ValueError("Binance nevrátila platné vyplnění objednávky")

    symbol = intent["symbol"]
    position = state["positions"].setdefault(symbol, {})
    client_order_id = intent["client_order_id"]
    already_applied = position.get("entry_order_client_id") == client_order_id
    if not already_applied:
        entry_price = quote_spent / quantity
        position.update(
            in_position=True,
            position_qty=quantity,
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
    if status == "FILLED":
        return "filled"
    if status in TERMINAL_FAILURES:
        return "failed"
    return "pending"
