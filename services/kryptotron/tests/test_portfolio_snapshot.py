import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from datetime import datetime, timezone

from utils import portfolio_snapshot_due, read_portfolio_snapshot


class FakeClient:
    def get_account(self):
        return {"balances": [
            {"asset": "USDC", "free": "25", "locked": "5"},
            {"asset": "BTC", "free": "0.001", "locked": "0.002"},
            {"asset": "EMPTY", "free": "0", "locked": "0"},
        ]}

    def get_all_tickers(self):
        return [{"symbol": "BTCUSDC", "price": "50000"}]


class PortfolioSnapshotTests(unittest.TestCase):
    def test_emits_bounded_credential_free_portfolio(self):
        snapshot = read_portfolio_snapshot(FakeClient(), "USDC")
        self.assertEqual(snapshot["schema_version"], "ocean.worker-portfolio.v1")
        self.assertEqual(snapshot["quote_currency"], "USDC")
        self.assertEqual(snapshot["assets"], [
            {"asset": "USDC", "quantity": 30.0, "price_usdc": 1.0},
            {"asset": "BTC", "quantity": 0.003, "price_usdc": 50000.0},
        ])
        self.assertNotIn("free", str(snapshot))
        self.assertNotIn("locked", str(snapshot))

    def test_refresh_is_due_after_ten_minutes(self):
        now = datetime(2026, 9, 15, 10, 20, tzinfo=timezone.utc)
        fresh = {"portfolio_snapshot": {"captured_at": "2026-09-15T10:11:00+00:00"}}
        old = {"portfolio_snapshot": {"captured_at": "2026-09-15T10:10:00+00:00"}}

        self.assertFalse(portfolio_snapshot_due(fresh, now))
        self.assertTrue(portfolio_snapshot_due(old, now))
        self.assertTrue(portfolio_snapshot_due({}, now))


if __name__ == "__main__":
    unittest.main()
