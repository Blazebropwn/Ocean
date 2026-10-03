"""Restore only a user's explicit, position-bound protection request."""
from datetime import datetime, timezone
from decimal import Decimal
from uuid import uuid4
from manual_close import position_id, active_request
from reconciliation import inspect_account
from protection import trailing_delta_filter, floor_to_tick


def active_restore(state):
    request = state.get("protection_restore") or {}
    return request if request.get("status") in ("queued", "submitting") else None


def process_restore(client, state, pair_filters, *, save, sync, place, now=None):
    request = active_restore(state)
    if not request:
        return
    now = now or datetime.now(timezone.utc)
    symbol = request["symbol"]
    ps = state.get("positions", {}).get(symbol, {})
    def finish(status):
        request.update(status=status, completed_at=now.isoformat())
        if not save(state):
            raise RuntimeError("Výsledek obnovení ochrany není uložený")
    if request["status"] == "submitting":
        if state.get("pending_protection"):
            raise RuntimeError("Ochranný příkaz čeká na ověření; další se neodesílá")
        if not ps.get("in_position") or position_id(ps) != request.get("position_id"):
            finish("superseded")
            return
        if ps.get("protection_client_id") == request.get("new_client_id"):
            outcome = sync(client, state, symbol)
            if outcome["status"] == "active":
                finish("completed")
                return
            if outcome["status"] == "filled" or not ps.get("in_position"):
                finish("superseded")
                return
        raise RuntimeError("Výsledek obnovení ochrany vyžaduje ověření")
    if not ps.get("in_position") or position_id(ps) != request.get("position_id"):
        finish("superseded")
        return
    age = (now - datetime.fromisoformat(request["requested_at"].replace("Z", "+00:00"))).total_seconds()
    pinned = (("position_qty", "quantity"), ("protection_stop_price", "stop_price"),
              ("protection_activation_price", "activation_price"), ("protection_trailing_bips", "trailing_bips"))
    if (symbol not in ("BTCUSDC", "ETHUSDC") or not -30 <= age <= 600
            or state.get("entries_paused") is not True or state.get("api_permissions_safe") is not True
            or state.get("pending_order") or state.get("pending_protection") or state.get("dca", {}).get("pending")
            or state.get("pending_trade_logs") or active_request(state)
            or ps.get("protection_client_id") != request.get("protection_id")
            or any(ps.get(a) != request.get(b) for a, b in pinned)):
        finish("rejected")
        return
    if sync(client, state, symbol)["status"] != "cancelled":
        finish("rejected")
        return
    pairs = [{"symbol": s, "base": s.removesuffix("USDC"), "step_size": f[0]} for s, f in pair_filters.items()]
    check = inspect_account(client, state, pairs, now=now)
    if not check["issues"] or any(i["code"] != "PROTECTION_ERROR" or i["symbol"] not in ("BTCUSDC", "ETHUSDC")
                                  or not state["positions"].get(i["symbol"], {}).get("in_position") for i in check["issues"]):
        finish("rejected")
        return
    quantity = Decimal(str(request["quantity"]))
    step, tick, minimum = pair_filters[symbol]
    stop, activation = Decimal(str(request["stop_price"])), Decimal(str(request["activation_price"]))
    bounds = trailing_delta_filter(client.get_symbol_info(symbol))
    bips = request["trailing_bips"]
    free = Decimal(str(client.get_asset_balance(asset=symbol.removesuffix("USDC"))["free"]))
    price = Decimal(str(client.get_symbol_ticker(symbol=symbol)["price"]))
    if (not all(v.is_finite() and v > 0 for v in (quantity, stop, activation, price)) or not free.is_finite()
            or quantity > free or floor_to_tick(quantity, step) != quantity
            or floor_to_tick(stop, tick) != stop or floor_to_tick(activation, tick) != activation
            or not stop < price < activation or quantity * price < Decimal(str(minimum))
            or not isinstance(bips, int) or not bounds[0] <= bips <= bounds[1]):
        finish("rejected")
        return
    suffix = uuid4().hex[:12]
    order = {"symbol": symbol, "side": "SELL", "quantity": str(quantity),
             "listClientOrderId": f"ocean-protect-{symbol.lower()}-{suffix}",
             "aboveClientOrderId": f"ocean-trail-{suffix}", "aboveType": "TAKE_PROFIT",
             "aboveStopPrice": str(activation), "aboveTrailingDelta": bips,
             "belowClientOrderId": f"ocean-stop-{suffix}", "belowType": "STOP_LOSS", "belowStopPrice": str(stop)}
    request.update(status="submitting", new_client_id=order["listClientOrderId"])
    # place persists the request and pending OCO together BEFORE submission.
    # Unknown outcomes are reconciled by this exact ID, never submitted again.
    place(client, state, symbol, order)
    if sync(client, state, symbol)["status"] != "active":
        raise RuntimeError("Nová ochrana zatím není potvrzená")
    finish("completed")
