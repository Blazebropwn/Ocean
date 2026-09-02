from datetime import datetime, timezone
from zoneinfo import ZoneInfo


PRAGUE = ZoneInfo("Europe/Prague")


def week_key(now=None):
    current = (now or datetime.now(timezone.utc)).astimezone(PRAGUE)
    iso = current.isocalendar()
    return f"{iso.year}-W{iso.week:02d}"


def dca_due(state, now=None):
    current = (now or datetime.now(timezone.utc)).astimezone(PRAGUE)
    dca = state.setdefault("dca", {})
    return current.weekday() == 6 and current.hour >= 8 and dca.get("completed_week") != week_key(now)


def client_order_id(symbol, current_week):
    return f"ocean-dca-{symbol.lower()}-{current_week.lower()}"


def order_outcome(order):
    status = order.get("status")
    if status == "FILLED":
        return "filled"
    if status in {"CANCELED", "REJECTED", "EXPIRED", "EXPIRED_IN_MATCH"}:
        return "failed"
    return "pending"


def purchase_record(symbol, amount, order, current_week):
    quantity = float(order.get("executedQty", 0))
    spent = float(order.get("cummulativeQuoteQty", amount))
    return {
        "week": current_week,
        "symbol": symbol,
        "amount": spent,
        "quantity": quantity,
        "average_price": spent / quantity if quantity else None,
        "order_id": order.get("orderId"),
        "at": datetime.now(timezone.utc).isoformat(),
    }


def run_weekly_dca(client, state, symbols, amount, min_notionals, save_state, get_balance, now=None, run_key=None):
    manual_run = run_key is not None
    if not manual_run and not dca_due(state, now):
        return []
    current_week = run_key or week_key(now)
    dca = state.setdefault("dca", {})
    dca.setdefault("purchases", [])
    completed = {item["symbol"] for item in dca["purchases"] if item.get("week") == current_week}
    results = []

    for symbol in symbols:
        if symbol in completed:
            continue
        minimum = min_notionals[symbol]
        if amount < minimum:
            results.append({"symbol": symbol, "status": "skipped", "reason": f"minimum {minimum:.2f}"})
            continue
        if get_balance(client) < amount:
            results.append({"symbol": symbol, "status": "skipped", "reason": "nedostatečný balance"})
            continue

        pending = dca.get("pending")
        order_id = client_order_id(symbol, current_week)
        if pending and pending.get("symbol") == symbol and pending.get("week") == current_week:
            order = client.get_order(symbol=symbol, origClientOrderId=pending["client_order_id"])
        else:
            dca["pending"] = {"week": current_week, "symbol": symbol, "client_order_id": order_id, "amount": amount}
            if not save_state(state):
                raise RuntimeError("DCA záměr se nepodařilo bezpečně uložit")
            order = client.order_market_buy(symbol=symbol, quoteOrderQty=f"{amount:.2f}", newClientOrderId=order_id)

        outcome = order_outcome(order)
        if outcome == "pending":
            raise RuntimeError(f"DCA objednávka {symbol} čeká na dokončení")
        if outcome == "failed":
            dca["pending"] = None
            save_state(state)
            results.append({"symbol": symbol, "status": "failed", "reason": order.get("status", "unknown")})
            continue

        record = purchase_record(symbol, amount, order, current_week)
        dca["purchases"].append(record)
        dca["purchases"] = dca["purchases"][-156:]
        dca["pending"] = None
        if not save_state(state):
            dca["pending"] = {"week": current_week, "symbol": symbol, "client_order_id": order_id, "amount": amount}
            raise RuntimeError("DCA nákup proběhl, ale výsledek se nepodařilo uložit")
        results.append({"symbol": symbol, "status": "filled", **record})

    if not manual_run:
        dca["completed_week"] = current_week
    dca["last_results"] = results
    if not save_state(state):
        raise RuntimeError("Dokončení DCA týdne se nepodařilo uložit")
    return results
