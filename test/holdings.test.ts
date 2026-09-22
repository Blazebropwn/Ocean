import test from "node:test";
import assert from "node:assert/strict";
import { readHoldings } from "../src/holdings.js";

const now = Date.parse("2026-09-22T08:39:00Z");
const snapshot = {
  schema_version: "ocean.worker-portfolio.v1", quote_currency: "USDC", captured_at: "2026-09-22T08:35:00Z",
  assets: [{ asset: "BTC", quantity: 0.0002, price_usdc: 86_000 }, { asset: "USDC", quantity: 54.19, price_usdc: 1 }],
};

test("portfolio cards use actual holdings, including order-locked quantities from the worker snapshot", () => {
  const holdings = readHoldings(snapshot, now);
  assert.equal(holdings.stale, false);
  assert.deepEqual(holdings.assets.find((asset) => asset.asset === "BTC"), { asset: "BTC", quantity: 0.0002, price: 86_000, value: 17.2 });
  assert.equal(holdings.assets.find((asset) => asset.asset === "ETH")?.quantity, 0);
});

test("missing or invalid snapshots never become zero balances", () => {
  for (const value of [null, {}, { ...snapshot, captured_at: "invalid" }, { ...snapshot, quote_currency: "EUR" }]) {
    const result = readHoldings(value, now);
    assert.equal(result.stale, true);
    assert.ok(result.assets.every((asset) => asset.quantity === null));
  }
});

test("outdated and future-dated prices are marked stale; invalid quantities remain unknown", () => {
  assert.equal(readHoldings(snapshot, now + 13 * 60_000).stale, true);
  assert.equal(readHoldings(snapshot, now - 10 * 60_000).stale, true);
  const result = readHoldings({ ...snapshot, assets: [{ asset: "BTC", quantity: -2, price_usdc: Infinity }] }, now);
  assert.equal(result.assets[1]?.quantity, null);
  assert.equal(result.assets[1]?.value, null);
});
