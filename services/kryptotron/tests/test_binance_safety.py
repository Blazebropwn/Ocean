import pytest
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from binance_safety import UnsafeBinancePermissions, require_safe_api_permissions


class Client:
    def __init__(self, permissions=None):
        self.permissions = permissions
        self.calls = 0

    def get_account_api_permissions(self):
        self.calls += 1
        return self.permissions


def test_testnet_does_not_call_mainnet_permission_endpoint():
    client = Client()
    require_safe_api_permissions(client, True)
    assert client.calls == 0


def test_mainnet_requires_reading_trading_and_disabled_withdrawals():
    client = Client({
        "enableWithdrawals": False,
        "enableReading": True,
        "enableSpotAndMarginTrading": True,
    })
    require_safe_api_permissions(client, False)
    assert client.calls == 1


@pytest.mark.parametrize("permissions", [
    {"enableWithdrawals": True, "enableReading": True, "enableSpotAndMarginTrading": True},
    {"enableReading": True, "enableSpotAndMarginTrading": True},
    {"enableWithdrawals": False, "enableReading": False, "enableSpotAndMarginTrading": True},
    {"enableWithdrawals": False, "enableReading": True, "enableSpotAndMarginTrading": False},
])
def test_unsafe_mainnet_permissions_are_rejected(permissions):
    with pytest.raises(UnsafeBinancePermissions):
        require_safe_api_permissions(Client(permissions), False)
