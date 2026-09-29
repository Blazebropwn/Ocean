"""Durable manual-exit protocol shared by execution and entry gates."""
ACTIVE = {"queued", "cancelling", "ready", "selling"}


def position_id(position):
    return position.get("entry_order_client_id") or position.get("entry_time")


def active_request(state):
    request = state.get("manual_close") or {}
    return request if request.get("status") in ACTIVE else None
