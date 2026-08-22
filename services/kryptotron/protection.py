from decimal import Decimal, ROUND_DOWN
from uuid import uuid4


def percent_to_bips(percent):
    bips = Decimal(str(percent)) * 100
    if bips != bips.to_integral_value():
        raise ValueError("Trailing vzdálenost musí odpovídat celým BIPS")
    return int(bips)


def floor_to_tick(value, tick_size):
    value = Decimal(str(value))
    tick = Decimal(str(tick_size))
    if tick <= 0:
        raise ValueError("Tick size musí být kladný")
    return ((value / tick).to_integral_value(rounding=ROUND_DOWN) * tick).quantize(tick)


def decimal_string(value):
    return format(value, "f")


def build_protection_oco(
    symbol,
    quantity,
    entry_price,
    tick_size,
    max_loss_pct,
    trail_activate_pct,
    trail_distance_pct,
    min_trailing_bips,
    max_trailing_bips,
):
    quantity = Decimal(str(quantity))
    entry = Decimal(str(entry_price))
    if quantity <= 0 or entry <= 0:
        raise ValueError("Pozice musí mít kladnou cenu a množství")
    if not 0 < Decimal(str(max_loss_pct)) < 100:
        raise ValueError("Nouzový stop musí být mezi 0 a 100 %")
    if Decimal(str(trail_activate_pct)) <= 0:
        raise ValueError("Aktivace trailingu musí být kladná")

    trailing_bips = percent_to_bips(trail_distance_pct)
    if not int(min_trailing_bips) <= trailing_bips <= int(max_trailing_bips):
        raise ValueError("Trailing vzdálenost nesplňuje Binance TRAILING_DELTA filtr")

    stop_price = floor_to_tick(entry * (1 - Decimal(str(max_loss_pct)) / 100), tick_size)
    activation_price = floor_to_tick(entry * (1 + Decimal(str(trail_activate_pct)) / 100), tick_size)
    suffix = uuid4().hex[:12]
    list_id = f"ocean-protect-{symbol.lower()}-{suffix}"
    return {
        "symbol": symbol,
        "side": "SELL",
        "quantity": decimal_string(quantity),
        "listClientOrderId": list_id,
        "aboveClientOrderId": f"ocean-trail-{suffix}",
        "aboveType": "TAKE_PROFIT",
        "aboveStopPrice": decimal_string(activation_price),
        "aboveTrailingDelta": trailing_bips,
        "belowClientOrderId": f"ocean-stop-{suffix}",
        "belowType": "STOP_LOSS",
        "belowStopPrice": decimal_string(stop_price),
    }


def trailing_delta_filter(symbol_info):
    for item in symbol_info.get("filters", []):
        if item.get("filterType") == "TRAILING_DELTA":
            return int(item["minTrailingBelowDelta"]), int(item["maxTrailingBelowDelta"])
    raise ValueError("Symbol nemá Binance TRAILING_DELTA filtr")


def store_protection(position, response, request):
    order_list_id = response.get("orderListId")
    if order_list_id is None:
        raise ValueError("Binance nevrátila ID ochranné OCO objednávky")
    position.update(
        position_qty=float(request["quantity"]),
        protection_order_list_id=order_list_id,
        protection_client_id=request["listClientOrderId"],
        protection_status="ACTIVE",
        protection_stop_price=float(request["belowStopPrice"]),
        protection_activation_price=float(request["aboveStopPrice"]),
        protection_trailing_bips=int(request["aboveTrailingDelta"]),
    )
    return position


def clear_protection(position):
    position.update(
        protection_order_list_id=None,
        protection_client_id=None,
        protection_status=None,
        protection_stop_price=None,
        protection_activation_price=None,
        protection_trailing_bips=None,
    )
    return position


def protection_outcome(client, symbol, order_list):
    filled = []
    for item in order_list.get("orders", []):
        order = client.get_order(symbol=symbol, orderId=item["orderId"])
        if order.get("status") == "FILLED":
            filled.append(order)

    if len(filled) > 1:
        raise RuntimeError("Binance hlásí více vyplněných větví jedné OCO ochrany")
    if filled:
        order = filled[0]
        quantity = Decimal(str(order.get("executedQty", "0")))
        quote = Decimal(str(order.get("cummulativeQuoteQty", "0")))
        if quantity <= 0:
            raise RuntimeError("Vyplněná ochranná objednávka nemá platné množství")
        client_id = order.get("clientOrderId", "")
        reason = "TRAILING_STOP" if client_id.startswith("ocean-trail-") else "EMERGENCY_STOP"
        return {
            "status": "filled",
            "exit_price": float(quote / quantity),
            "reason": reason,
            "order": order,
        }

    list_status = order_list.get("listOrderStatus")
    if list_status == "EXECUTING":
        return {"status": "active"}
    if list_status == "ALL_DONE":
        return {"status": "cancelled"}
    if list_status == "REJECT":
        return {"status": "failed"}
    raise RuntimeError(f"Neznámý stav Binance OCO: {list_status}")


def query_protection(client, symbol, client_id):
    return client.v3_get_order_list(origClientOrderId=client_id)


def cancel_protection(client, symbol, client_id):
    return client.v3_delete_order_list(symbol=symbol, listClientOrderId=client_id)
