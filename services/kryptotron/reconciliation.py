"""Read-only exchange reconciliation. Never submits, cancels or guesses a trade."""
from decimal import Decimal, InvalidOperation


def number(value):
    try:
        result = Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError) as exc:
        raise ValueError("Neplatné množství z burzy") from exc
    if not result.is_finite() or result < 0:
        raise ValueError("Neplatné množství z burzy")
    return result


def inspect_account(client, state, pairs, *, now, quote_asset="USDC"):
    account = client.get_account()
    if account.get("canTrade") is not True:
        raise RuntimeError("Burzovní účet nemá potvrzené oprávnění obchodovat")
    balances = {item["asset"]: {"free": number(item["free"]), "locked": number(item["locked"])}
                for item in account["balances"]}
    orders = client.get_open_orders()
    if not isinstance(orders, list):
        raise RuntimeError("Burza nevrátila platný seznam otevřených objednávek")
    issues = []
    positions = state.get("positions", {})
    known_lists = {p.get("protection_order_list_id") for p in positions.values() if p.get("in_position")}
    known_lists.discard(None)
    pending = [state.get("pending_order"), state.get("dca", {}).get("pending")]
    known_ids = {p["client_order_id"] for p in pending if p and p.get("client_order_id")}
    monitored = {p["symbol"] for p in pairs}
    for order in orders:
        if order.get("symbol") not in monitored:
            continue
        if order.get("clientOrderId") in known_ids:
            continue
        if order.get("orderListId") not in known_lists:
            issues.append({"code": "UNKNOWN_OPEN_ORDER", "symbol": order.get("symbol")})
    if any(pending) or state.get("pending_protection"):
        issues.append({"code": "PENDING_EXECUTION", "symbol": None})
    for pair in pairs:
        symbol, base = pair["symbol"], pair["base"]
        position = positions.get(symbol, {})
        held = balances.get(base, {"free": Decimal(0), "locked": Decimal(0)})
        tolerance = Decimal(str(pair.get("step_size", "0.00000001")))
        dca = state.get("dca", {})
        totals = dca.get("recorded_totals", {})
        dca_quantity = number(totals[symbol]["quantity"]) if symbol in totals else sum(
            (number(p.get("quantity", 0)) for p in dca.get("purchases", []) if p.get("symbol") == symbol), Decimal(0))
        strategy_quantity = number(position.get("position_qty", 0)) if position.get("in_position") else Decimal(0)
        # Explicitly acknowledged external inventory is never treated as a
        # strategy position or sold to reconcile a discrepancy.
        external = number(state.get("unmanaged_inventory", {}).get(base, 0))
        residual = number(state.get("strategy_residuals", {}).get(symbol, {}).get("quantity", 0))
        attributed = strategy_quantity + dca_quantity + external + residual
        total = held["free"] + held["locked"]
        if total > attributed + tolerance:
            issues.append({"code": "UNATTRIBUTED_BALANCE", "symbol": symbol})
        elif total + tolerance < attributed:
            issues.append({"code": "INVENTORY_MISMATCH", "symbol": symbol})
        if not position.get("in_position"):
            continue
        quantity = number(position.get("position_qty", 0))
        if quantity <= 0 or held["free"] + held["locked"] + tolerance < quantity:
            issues.append({"code": "POSITION_BALANCE_MISMATCH", "symbol": symbol})
        protective = [o for o in orders if o.get("symbol") == symbol and
                      o.get("orderListId") == position.get("protection_order_list_id")]
        # An OCO must contain the fixed stop AND the trailing branch, both live
        # and covering the recorded position. A local trailing flag is no proof.
        stop = [o for o in protective if str(o.get("clientOrderId", "")).startswith("ocean-stop-")]
        trail = [o for o in protective if str(o.get("clientOrderId", "")).startswith("ocean-trail-")]
        valid = len(stop) == len(trail) == 1
        for order in stop + trail:
            valid = valid and order.get("side") == "SELL" and order.get("status") == "NEW"
            remaining = number(order.get("origQty", 0)) - number(order.get("executedQty", 0))
            valid = valid and remaining + tolerance >= quantity and number(order.get("executedQty", 0)) == 0
        if not valid:
            issues.append({"code": "PROTECTION_ERROR", "symbol": symbol})
    quote = balances.get(quote_asset)
    if quote is None:
        raise RuntimeError("Burza nevrátila quote balance")
    return {"status": "UNRESOLVED" if issues else "OK", "checked_at": now.isoformat(),
            "issues": issues, "available_quote": float(quote["free"]),
            "balances": {asset: {key: float(value) for key, value in item.items()}
                         for asset, item in balances.items() if item["free"] or item["locked"]},
            "open_order_count": len(orders)}
