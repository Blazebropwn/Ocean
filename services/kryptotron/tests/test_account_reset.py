import sys
from pathlib import Path
from copy import deepcopy
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from account_reset import reset_report, process_account_reset


class Exchange:
    def __init__(self):
        self.orders = []
        self.balances = [{"asset": "USDC", "free": "100", "locked": "0"},
                         {"asset": "BTC", "free": "0.000008", "locked": "0"}]

    def get_open_orders(self):
        return self.orders

    def get_account(self):
        return {"canTrade": True, "balances": deepcopy(self.balances)}

    def get_symbol_ticker(self, **kwargs):
        return {"price": "80000"}


def state():
    return {"account_reset": {"id": "test", "status": "queued"}, "positions": {}, "entries_paused": True}


filters = {"BTCUSDC": (0.00001, 0.01, 5), "ETHUSDC": (0.0001, 0.01, 5), "SOLUSDC": (0.01, 0.01, 5)}


def test_reset_keeps_dust_separate_and_does_not_trade():
    result = reset_report(Exchange(), state(), filters)
    assert result["balances"] == {"USDC": "100", "BTC": "0.000008"}
    assert result["epoch"] is None
    assert "errorCode" not in result


@pytest.mark.parametrize("mutation,code", [
    (lambda e: setattr(e, "orders", [{"symbol": "OTHER"}]), "OPEN_ORDERS"),
    (lambda e: e.balances[1].update(locked="0.1"), "LOCKED_BALANCE"),
    (lambda e: e.balances[1].update(free="0.1"), "NON_DUST_BALANCE"),
    (lambda e: e.balances[1].update(free="NaN"), "EXCHANGE_UNAVAILABLE"),
])
def test_unsafe_exchange_state_rejects_without_mutation(mutation, code):
    exchange = Exchange()
    mutation(exchange)
    original = state()
    assert reset_report(exchange, original, filters)["errorCode"] == code
    assert original == state()


@pytest.mark.parametrize("patch", [
    {"pending_order": {"client_order_id": "unknown"}},
    {"pending_protection": {"id": "unknown"}},
    {"pending_trade_logs": [{}]},
    {"positions": {"BTCUSDC": {"in_position": True}}},
    {"dca": {"pending": {"id": "unknown"}}},
    {"manual_close": {"status": "selling"}},
    {"protection_restore": {"status": "queued"}},
])
def test_unsettled_work_blocks_reset(patch):
    assert reset_report(Exchange(), {**state(), **patch}, filters)["errorCode"] == "UNSETTLED"


def test_exchange_change_between_samples_fails_closed():
    exchange = Exchange()
    def price(**kwargs):
        exchange.balances[0]["free"] = "101"
        return {"price": "80000"}
    exchange.get_symbol_ticker = price
    assert reset_report(exchange, state(), filters)["errorCode"] == "EXCHANGE_UNAVAILABLE"


def test_lost_completion_does_not_mutate_local_state():
    local = state()
    def failed(_):
        raise RuntimeError("timeout")
    with pytest.raises(RuntimeError):
        process_account_reset(Exchange(), local, filters, failed)
    assert local == state()
    authoritative = {**state(), "state_epoch": "test", "account_reset": {"id": "test", "status": "completed"}}
    assert process_account_reset(Exchange(), local, filters, lambda _: authoritative)
    assert local == authoritative
    assert not process_account_reset(Exchange(), local, filters, failed)
