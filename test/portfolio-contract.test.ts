import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import {
  PortfolioSnapshotContractError,
  validatePortfolioSnapshot,
} from "../src/portfolio/contract.js";
import type { PortfolioProvider } from "../src/portfolio/provider.js";
import {
  completePortfolioSnapshotFixture,
  partialPortfolioSnapshotFixture,
  portfolioFixtureNow,
} from "./fixtures/portfolio.js";

test("accepts a complete, fresh and internally consistent snapshot", () => {
  const result = validatePortfolioSnapshot(completePortfolioSnapshotFixture(), portfolioFixtureNow);
  assert.equal(result.freshness, "fresh");
  assert.equal(result.snapshot.status, "complete");
});

test("accepts a partial snapshot only when a nonzero asset is unpriced", () => {
  const result = validatePortfolioSnapshot(partialPortfolioSnapshotFixture(), portfolioFixtureNow);
  assert.equal(result.snapshot.status, "partial");

  const invalid = completePortfolioSnapshotFixture();
  invalid.status = "partial";
  assert.throws(() => validatePortfolioSnapshot(invalid, portfolioFixtureNow), z.ZodError);
});

test("rejects duplicate assets", () => {
  const snapshot = completePortfolioSnapshotFixture();
  snapshot.assets.push(structuredClone(snapshot.assets[0]!));
  assert.throws(() => validatePortfolioSnapshot(snapshot, portfolioFixtureNow), z.ZodError);
});

test("rejects a value that does not equal quantity multiplied by price", () => {
  const snapshot = completePortfolioSnapshotFixture();
  snapshot.assets[1]!.value!.amount = 61;
  assert.throws(() => validatePortfolioSnapshot(snapshot, portfolioFixtureNow), z.ZodError);
});

test("rejects unknown fields, including accidental credentials", () => {
  const snapshot = completePortfolioSnapshotFixture() as PortfolioSnapshotWithSecret;
  snapshot.apiKey = "must-never-cross-the-provider-boundary";
  assert.throws(() => validatePortfolioSnapshot(snapshot, portfolioFixtureNow), z.ZodError);
});

test("rejects timestamps more than 60 seconds in the future", () => {
  const snapshot = completePortfolioSnapshotFixture();
  snapshot.capturedAt = "2026-09-14T12:01:01.000Z";
  assert.throws(
    () => validatePortfolioSnapshot(snapshot, portfolioFixtureNow),
    (error) =>
      error instanceof PortfolioSnapshotContractError && error.code === "FUTURE_TIMESTAMP",
  );
});

test("classifies snapshots older than five minutes as stale", () => {
  const snapshot = completePortfolioSnapshotFixture();
  snapshot.capturedAt = "2026-09-14T11:54:59.000Z";
  const result = validatePortfolioSnapshot(snapshot, portfolioFixtureNow);
  assert.equal(result.freshness, "stale");
});

test("rejects prices older than fifteen minutes", () => {
  const snapshot = completePortfolioSnapshotFixture();
  snapshot.assets[1]!.price!.observedAt = "2026-09-14T11:44:59.000Z";
  assert.throws(
    () => validatePortfolioSnapshot(snapshot, portfolioFixtureNow),
    (error) =>
      error instanceof PortfolioSnapshotContractError && error.code === "PRICE_TOO_OLD",
  );
});

test("rejects price timestamps more than 60 seconds in the future", () => {
  const snapshot = completePortfolioSnapshotFixture();
  snapshot.assets[1]!.price!.observedAt = "2026-09-14T12:01:01.000Z";
  assert.throws(
    () => validatePortfolioSnapshot(snapshot, portfolioFixtureNow),
    (error) =>
      error instanceof PortfolioSnapshotContractError && error.code === "FUTURE_TIMESTAMP",
  );
});

test("PortfolioProvider exposes only normalized snapshot input and output", async () => {
  const provider: PortfolioProvider = {
    id: "fixture-provider",
    async getSnapshot(input) {
      assert.deepEqual(input, {
        userId: "usr_0123456789abcdef0123456789abcdef",
        quoteCurrency: "USDC",
      });
      return completePortfolioSnapshotFixture();
    },
  };

  const snapshot = await provider.getSnapshot({
    userId: "usr_0123456789abcdef0123456789abcdef",
    quoteCurrency: "USDC",
  });
  assert.equal(snapshot.provider.readOnly, true);
});

type PortfolioSnapshotWithSecret = ReturnType<typeof completePortfolioSnapshotFixture> & {
  apiKey?: string;
};
