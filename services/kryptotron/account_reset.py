"""Explicit administrator reset: read-only exchange checks, then broker archive."""
from datetime import datetime, timezone
from decimal import Decimal
from reconciliation import number


def reset_report(client, state, pair_filters):
    request = state["account_reset"]
    report = {"id": request["id"], "epoch": state.get("state_epoch")}
    try:
        active = lambda value: bool(value) and value.get("status") not in ("completed", "rejected", "failed", "expired")
        if (state.get("pending_order") or state.get("pending_protection")
                or state.get("pending_trade_logs") or state.get("dca", {}).get("pending")
                or any(p.get("in_position") for p in state.get("positions", {}).values())
                or active(state.get("manual_close")) or active(state.get("protection_restore"))
                or active(state.get("dca", {}).get("test_request"))):
            return {**report, "errorCode": "UNSETTLED"}
        orders = client.get_open_orders()
        if not isinstance(orders, list):
            raise ValueError("Invalid orders")
        if orders:
            return {**report, "errorCode": "OPEN_ORDERS"}
        account = client.get_account()
        if account.get("canTrade") is not True:
            raise ValueError("Unverified account")
        balances = {}
        for item in account["balances"]:
            if number(item["locked"]) > 0:
                return {**report, "errorCode": "LOCKED_BALANCE"}
            balances[item["asset"]] = format(number(item["free"]), "f")
        if "USDC" not in balances:
            raise ValueError("Missing quote balance")
        for symbol in ("BTCUSDC", "ETHUSDC", "SOLUSDC"):
            quantity = number(balances.get(symbol[:-4], "0"))
            if not quantity:
                continue
            minimum = number(pair_filters[symbol][2])
            price = number(client.get_symbol_ticker(symbol=symbol)["price"])
            if price <= 0 or minimum <= 0:
                raise ValueError("Invalid price/filter")
            if quantity * price >= minimum:
                return {**report, "errorCode": "NON_DUST_BALANCE"}
        # Recheck after price requests; a changed balance/order invalidates the sample.
        second = client.get_account()
        second_balances = {v["asset"]: format(number(v["free"]), "f") for v in second["balances"]}
        if second.get("canTrade") is not True or any(number(v["locked"]) for v in second["balances"]):
            return {**report, "errorCode": "LOCKED_BALANCE"}
        if second_balances != balances or client.get_open_orders() != []:
            raise ValueError("Account changed during verification")
        return {**report, "checkedAt": datetime.now(timezone.utc).isoformat(),
                "balances": {a: q for a, q in balances.items() if Decimal(q) or a == "USDC"}}
    except Exception:
        return {**report, "errorCode": "EXCHANGE_UNAVAILABLE"}


def process_account_reset(client, state, pair_filters, complete):
    if (state.get("account_reset") or {}).get("status") != "queued":
        return False
    result = complete(reset_report(client, state, pair_filters))
    if not isinstance(result, dict) or result.get("account_reset", {}).get("id") != state["account_reset"]["id"]:
        raise RuntimeError("Ocean nepotvrdil výsledek resetu")
    state.clear()
    state.update(result)
    return True
