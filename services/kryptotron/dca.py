from datetime import datetime, timezone
from zoneinfo import ZoneInfo
from order_safety import classify_order, with_execution_fills
import math


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
    return classify_order(order)


def purchase_record(symbol, amount, order, current_week):
    quantity = float(order.get("executedQty", 0))
    base_fee = sum(float(fill.get("commission", 0)) for fill in order.get("fills", [])
                   if fill.get("commissionAsset") == symbol.removesuffix("USDC"))
    quantity -= base_fee
    spent = float(order.get("cummulativeQuoteQty", amount))
    if not all(math.isfinite(value) and value > 0 for value in (quantity, spent)):
        raise RuntimeError("DCA plnění nemá platné množství a cenu")
    return {
        "week": current_week,
        "symbol": symbol,
        "amount": spent,
        "quantity": quantity,
        "average_price": spent / quantity if quantity else None,
        "order_id": order.get("orderId"),
        "at": datetime.now(timezone.utc).isoformat(),
    }


def settle_pending_dca(client, state, save_state, order=None):
    """Resolve the durable intent before checking schedule, balance or settings."""
    dca = state.setdefault("dca", {})
    pending = dca.get("pending")
    if not pending:
        return None
    if order is None:
        order = client.get_order(symbol=pending["symbol"], origClientOrderId=pending["client_order_id"])
        order = with_execution_fills(client, pending["symbol"], order)
    outcome = order_outcome(order)
    if outcome in {"pending", "partial"}:
        raise RuntimeError("DCA objednávka čeká na úplné ověření")
    record = None
    if outcome in {"filled", "settled_partial"}:
        record = purchase_record(pending["symbol"], pending["amount"], order, pending["week"])
        record["client_order_id"] = pending["client_order_id"]
        if not any(p.get("client_order_id") == pending["client_order_id"] for p in dca.setdefault("purchases", [])):
            # Keep cumulative economic totals before trimming the UI history.
            if "recorded_totals" not in dca:
                totals = dca["recorded_totals"] = {}
                for previous in dca["purchases"]:
                    item = totals.setdefault(previous["symbol"], {"quantity": 0, "spent": 0, "count": 0})
                    item["quantity"] += previous["quantity"]
                    item["spent"] += previous["amount"]
                    item["count"] += 1
                dca["totals_scope"] = "available_history_at_upgrade_plus_future_fills"
            totals = dca["recorded_totals"]
            dca["purchases"].append(record)
            item = totals.setdefault(pending["symbol"], {"quantity": 0, "spent": 0, "count": 0})
            item["quantity"] += record["quantity"]
            item["spent"] += record["amount"]
            item["count"] += 1
            dca["purchases"] = dca["purchases"][-156:]
    dca["pending"] = None
    if not save_state(state):
        dca["pending"] = pending
        raise RuntimeError("Výsledek DCA není bezpečně uložený")
    return {"symbol": pending["symbol"], "status": "filled", **record} if record else {
        "symbol": pending["symbol"], "status": "failed", "reason": order.get("status", "unknown")}


def run_weekly_dca(client, state, symbols, amount, min_notionals, save_state, get_balance, now=None, run_key=None, before_order=None):
    recovered = settle_pending_dca(client, state, save_state)
    manual_run = run_key is not None
    if not manual_run and not dca_due(state, now):
        return []
    current_week = run_key or week_key(now)
    dca = state.setdefault("dca", {})
    dca.setdefault("purchases", [])
    completed = {item["symbol"] for item in dca["purchases"] if item.get("week") == current_week}
    results = [recovered] if recovered else []

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

        order_id = client_order_id(symbol, current_week)
        if before_order is not None and not before_order():
            raise RuntimeError("Nový DCA příkaz blokuje pauza nebo bezpečnostní kontrola")
        dca["pending"] = {"week": current_week, "symbol": symbol, "client_order_id": order_id, "amount": amount}
        if not save_state(state):
            raise RuntimeError("DCA záměr se nepodařilo bezpečně uložit")
        order = client.order_market_buy(symbol=symbol, quoteOrderQty=f"{amount:.2f}", newClientOrderId=order_id)
        results.append(settle_pending_dca(client, state, save_state, order))

    if not manual_run:
        dca["completed_week"] = current_week
    dca["last_results"] = results
    if not save_state(state):
        raise RuntimeError("Dokončení DCA týdne se nepodařilo uložit")
    return results
