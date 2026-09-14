import type { PortfolioSnapshot } from "../../src/portfolio/contract.js";

export const portfolioFixtureNow = new Date("2026-09-14T12:00:00.000Z");

export function completePortfolioSnapshotFixture(): PortfolioSnapshot {
  return {
    schemaVersion: "portfolio.snapshot.v1",
    snapshotId: "psn_0123456789abcdef0123456789abcdef",
    provider: {
      id: "binance-spot",
      source: "binance",
      environment: "testnet",
      readOnly: true,
    },
    subject: {
      userId: "usr_0123456789abcdef0123456789abcdef",
      accountRef: "binance-account-01",
    },
    quoteCurrency: "USDC",
    capturedAt: "2026-09-14T11:59:00.000Z",
    status: "complete",
    assets: [
      {
        asset: "USDC",
        quantity: 100,
        price: {
          amount: 1,
          quotedIn: "USDC",
          source: "binance-ticker",
          observedAt: "2026-09-14T11:59:00.000Z",
        },
        value: { amount: 100, quotedIn: "USDC" },
      },
      {
        asset: "BTC",
        quantity: 0.001,
        price: {
          amount: 60_000,
          quotedIn: "USDC",
          source: "binance-ticker",
          observedAt: "2026-09-14T11:59:00.000Z",
        },
        value: { amount: 60, quotedIn: "USDC" },
      },
    ],
  };
}

export function partialPortfolioSnapshotFixture(): PortfolioSnapshot {
  const snapshot = completePortfolioSnapshotFixture();
  snapshot.status = "partial";
  snapshot.assets.push({
    asset: "UNKNOWN",
    quantity: 2,
    price: null,
    value: null,
  });
  return snapshot;
}
