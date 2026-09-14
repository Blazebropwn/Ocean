import test from "node:test";
import assert from "node:assert/strict";
import {
  PortfolioRiskReportValidationError,
  createPortfolioRiskReport,
  validatePortfolioRiskReport,
} from "../src/agents/risk-report.js";
import {
  completePortfolioSnapshotFixture,
  partialPortfolioSnapshotFixture,
  portfolioFixtureNow,
} from "./fixtures/portfolio.js";

test("AGENT-001 deterministically calculates every predefined risk metric", () => {
  const first = createPortfolioRiskReport(completePortfolioSnapshotFixture(), portfolioFixtureNow);
  const second = createPortfolioRiskReport(completePortfolioSnapshotFixture(), portfolioFixtureNow);

  assert.deepEqual(first, second);
  assert.deepEqual(first.metrics, {
    totalValue: 160,
    assetCount: 2,
    largestPosition: { asset: "USDC", value: 100, sharePct: 62.5 },
    top3ConcentrationPct: 100,
    stablecoinExposurePct: 62.5,
    hhi: 0.53125,
    riskScore: 50.78,
    riskLevel: "moderate",
  });
  assert.deepEqual(first.dataQuality, {
    snapshotStatus: "complete",
    freshness: "fresh",
    pricedAssetCount: 2,
    unpricedAssetCount: 0,
    unpricedAssets: [],
  });
  assert.equal(first.mode, "simulation");
  assert.equal(first.findings[0]?.code, "HIGH_SINGLE_ASSET_CONCENTRATION");
});

test("partial snapshots expose unknown assets instead of hiding them", () => {
  const report = createPortfolioRiskReport(partialPortfolioSnapshotFixture(), portfolioFixtureNow);
  assert.equal(report.dataQuality.snapshotStatus, "partial");
  assert.equal(report.dataQuality.unpricedAssetCount, 1);
  assert.deepEqual(report.dataQuality.unpricedAssets, ["UNKNOWN"]);
  assert.equal(report.metrics.assetCount, 3);
  assert.equal(report.metrics.totalValue, 160);
  assert.equal(report.metrics.riskScore, 65.78);
  assert.equal(report.metrics.riskLevel, "high");
  assert.equal(report.findings.some(({ code }) => code === "UNPRICED_ASSETS"), true);
});

test("empty portfolio produces a valid zero-value report", () => {
  const snapshot = completePortfolioSnapshotFixture();
  snapshot.assets = [];
  const report = createPortfolioRiskReport(snapshot, portfolioFixtureNow);
  assert.equal(report.metrics.totalValue, 0);
  assert.equal(report.metrics.largestPosition, null);
  assert.equal(report.metrics.riskScore, 0);
  assert.equal(report.findings[0]?.code, "EMPTY_PORTFOLIO");
});

test("validator accepts an authentic report and rejects altered results", () => {
  const snapshot = completePortfolioSnapshotFixture();
  const report = createPortfolioRiskReport(snapshot, portfolioFixtureNow);
  assert.deepEqual(validatePortfolioRiskReport(report, snapshot, portfolioFixtureNow), report);

  const altered = structuredClone(report);
  altered.metrics.totalValue = 999;
  assert.throws(
    () => validatePortfolioRiskReport(altered, snapshot, portfolioFixtureNow),
    (error) => error instanceof PortfolioRiskReportValidationError && error.code === "REPORT_MISMATCH",
  );
});

test("validator rejects a report timestamp from the future", () => {
  const snapshot = completePortfolioSnapshotFixture();
  const report = createPortfolioRiskReport(snapshot, portfolioFixtureNow);
  report.generatedAt = "2026-09-14T12:02:00.000Z";
  assert.throws(
    () => validatePortfolioRiskReport(report, snapshot, portfolioFixtureNow),
    (error) => error instanceof PortfolioRiskReportValidationError && error.code === "REPORT_TIMESTAMP_INVALID",
  );
});

test("report records stale input and cannot predate its snapshot", () => {
  const snapshot = completePortfolioSnapshotFixture();
  snapshot.capturedAt = "2026-09-14T11:50:00.000Z";
  const report = createPortfolioRiskReport(snapshot, portfolioFixtureNow);
  assert.equal(report.dataQuality.freshness, "stale");

  assert.throws(
    () => createPortfolioRiskReport(completePortfolioSnapshotFixture(), new Date("2026-09-14T11:58:30.000Z")),
    (error) => error instanceof PortfolioRiskReportValidationError && error.code === "REPORT_TIMESTAMP_INVALID",
  );
});
