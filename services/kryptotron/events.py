from datetime import datetime, timezone


def add_event(state, event_type, message, at=None):
    event = {
        "type": str(event_type),
        "message": str(message)[:180],
        "at": (at or datetime.now(timezone.utc)).isoformat(),
    }
    events = state.setdefault("events", [])
    events.insert(0, event)
    del events[20:]
    return event
