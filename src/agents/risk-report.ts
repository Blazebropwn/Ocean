import { z } from "zod";
import {
  PORTFOLIO_TIMESTAMP_FUTURE_TOLERANCE_MS,
  validatePortfolioSnapshot,
  type PortfolioSnapshot,
  type PortfolioSnapshotFreshness,
} from "../portfolio/contract.js";

export const PORTFOLIO_RISK_REPORT_SCHEMA_VERSION = "portfolio.risk-report.v1" as const;
export const STABLECOIN_ASSETS = new Set(["USDC", "USDT", "DAI", "FDUSD", "TUSD", "USDP"]);

const finiteNonnegative = z.number().finite().nonnegative();
const percentage = z.number().finite().min(0).max(100);

const positionSchema = z.strictObject({
  asset: z.string().regex(/^[A-Z0-9]{2,16}$/),
  value: finiteNonnegative,
  sharePct: percentage,
});

const findingSchema = z.strictObject({
  code: z.enum([
    "EMPTY_PORTFOLIO",
    "UNPRICED_ASSETS",
    "HIGH_SINGLE_ASSET_CONCENTRATION",
    "LOW_DIVERSIFICATION",
    "NO_MAJOR_CONCENTRATION_FLAGS",
  ]),
  severity: z.enum(["info", "warning"]),
  message: z.string().min(1).max(240),
});

export const portfolioRiskReportSchema = z.strictObject({
  schemaVersion: z.literal(PORTFOLIO_RISK_REPORT_SCHEMA_VERSION),
  reportId: z.string().regex(/^rpt_[a-f0-9]{32}$/),
  snapshotId: z.string().regex(/^psn_[a-f0-9]{32}$/),
  subjectUserId: z.string().regex(/^usr_[a-f0-9]{32}$/),
  generatedAt: z.iso.datetime({ offset: true }),
  mode: z.literal("simulation"),
  quoteCurrency: z.literal("USDC"),
  dataQuality: z.strictObject({
    snapshotStatus: z.enum(["complete", "partial"]),
    freshness: z.enum(["fresh", "stale"]),
    pricedAssetCount: z.number().int().nonnegative(),
    unpricedAssetCount: z.number().int().nonnegative(),
    unpricedAssets: z.array(z.string().regex(/^[A-Z0-9]{2,16}$/)),
  }),
  metrics: z.strictObject({
    totalValue: finiteNonnegative,
    assetCount: z.number().int().nonnegative(),
    largestPosition: positionSchema.nullable(),
    top3ConcentrationPct: percentage,
    stablecoinExposurePct: percentage,
    hhi: z.number().finite().min(0).max(1),
    riskScore: percentage,
    riskLevel: z.enum(["low", "moderate", "high"]),
  }),
  findings: z.array(findingSchema).min(1).max(4),
});

export type PortfolioRiskReport = z.infer<typeof portfolioRiskReportSchema>;

export class PortfolioRiskReportValidationError extends Error {
  constructor(
    message: string,
    public readonly code: "REPORT_TIMESTAMP_INVALID" | "REPORT_MISMATCH",
  ) {
    super(message);
    this.name = "PortfolioRiskReportValidationError";
  }
}

function round(value: number, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function riskLevel(score: number): "low" | "moderate" | "high" {
  if (score >= 65) return "high";
  if (score >= 35) return "moderate";
  return "low";
}

function findingsFor(
  assetCount: number,
  unpricedAssets: string[],
  largestPosition: PortfolioRiskReport["metrics"]["largestPosition"],
): PortfolioRiskReport["findings"] {
  const findings: PortfolioRiskReport["findings"] = [];
  if (assetCount === 0) {
    findings.push({ code: "EMPTY_PORTFOLIO", severity: "info", message: "Portfolio neobsahuje žádná aktiva s nenulovým množstvím." });
  }
  if (unpricedAssets.length > 0) {
    const preview = unpricedAssets.slice(0, 8).join(", ");
    const remainder = unpricedAssets.length > 8 ? ` a dalších ${unpricedAssets.length - 8}` : "";
    findings.push({ code: "UNPRICED_ASSETS", severity: "warning", message: `Bez ceny (${unpricedAssets.length}): ${preview}${remainder}. Koncentrace vychází pouze z oceněné části portfolia.` });
  }
  if (largestPosition && largestPosition.sharePct >= 60) {
    findings.push({ code: "HIGH_SINGLE_ASSET_CONCENTRATION", severity: "warning", message: `${largestPosition.asset} tvoří ${largestPosition.sharePct.toFixed(2)} % oceněného portfolia.` });
  }
  if (assetCount === 1) {
    findings.push({ code: "LOW_DIVERSIFICATION", severity: "warning", message: "Portfolio obsahuje pouze jedno aktivum s nenulovým množstvím." });
  }
  if (findings.length === 0) {
    findings.push({ code: "NO_MAJOR_CONCENTRATION_FLAGS", severity: "info", message: "Deterministická kontrola nenašla výrazný koncentrační signál." });
  }
  return findings;
}

function buildReport(
  snapshot: PortfolioSnapshot,
  freshness: PortfolioSnapshotFreshness,
  generatedAt: Date,
): PortfolioRiskReport {
  const holdings = snapshot.assets.filter((asset) => asset.quantity > 0);
  const priced = holdings
    .filter((asset): asset is typeof asset & { value: NonNullable<typeof asset.value> } => asset.value !== null)
    .sort((left, right) => right.value.amount - left.value.amount || left.asset.localeCompare(right.asset));
  const unpricedAssets = holdings.filter((asset) => asset.value === null).map((asset) => asset.asset).sort();
  const totalValueRaw = priced.reduce((total, asset) => total + asset.value.amount, 0);
  const shares = totalValueRaw === 0 ? priced.map(() => 0) : priced.map((asset) => asset.value.amount / totalValueRaw);
  const largest = priced[0];
  const largestSharePct = shares[0] === undefined ? 0 : round(shares[0] * 100);
  const hhi = round(shares.reduce((total, share) => total + share ** 2, 0), 6);
  const stablecoinValue = priced
    .filter((asset) => STABLECOIN_ASSETS.has(asset.asset))
    .reduce((total, asset) => total + asset.value.amount, 0);
  const riskScore = round(Math.min(100, largestSharePct * 0.6 + hhi * 25 + (unpricedAssets.length > 0 ? 15 : 0)));
  const largestPosition = largest ? {
    asset: largest.asset,
    value: round(largest.value.amount, 8),
    sharePct: largestSharePct,
  } : null;

  return portfolioRiskReportSchema.parse({
    schemaVersion: PORTFOLIO_RISK_REPORT_SCHEMA_VERSION,
    reportId: `rpt_${snapshot.snapshotId.slice(4)}`,
    snapshotId: snapshot.snapshotId,
    subjectUserId: snapshot.subject.userId,
    generatedAt: generatedAt.toISOString(),
    mode: "simulation",
    quoteCurrency: snapshot.quoteCurrency,
    dataQuality: {
      snapshotStatus: snapshot.status,
      freshness,
      pricedAssetCount: priced.length,
      unpricedAssetCount: unpricedAssets.length,
      unpricedAssets,
    },
    metrics: {
      totalValue: round(totalValueRaw, 8),
      assetCount: holdings.length,
      largestPosition,
      top3ConcentrationPct: round(shares.slice(0, 3).reduce((total, share) => total + share, 0) * 100),
      stablecoinExposurePct: totalValueRaw === 0 ? 0 : round((stablecoinValue / totalValueRaw) * 100),
      hhi,
      riskScore,
      riskLevel: riskLevel(riskScore),
    },
    findings: findingsFor(holdings.length, unpricedAssets, largestPosition),
  });
}

export function createPortfolioRiskReport(
  input: unknown,
  generatedAt: Date = new Date(),
): PortfolioRiskReport {
  const { snapshot, freshness } = validatePortfolioSnapshot(input, generatedAt);
  if (generatedAt.getTime() < Date.parse(snapshot.capturedAt)) {
    throw new PortfolioRiskReportValidationError("Report nemůže předcházet portfolio snapshotu.", "REPORT_TIMESTAMP_INVALID");
  }
  return buildReport(snapshot, freshness, generatedAt);
}

export function validatePortfolioRiskReport(
  input: unknown,
  snapshotInput: unknown,
  now: Date = new Date(),
): PortfolioRiskReport {
  const report = portfolioRiskReportSchema.parse(input);
  const generatedAt = new Date(report.generatedAt);
  if (generatedAt.getTime() > now.getTime() + PORTFOLIO_TIMESTAMP_FUTURE_TOLERANCE_MS) {
    throw new PortfolioRiskReportValidationError("Čas reportu je příliš daleko v budoucnosti.", "REPORT_TIMESTAMP_INVALID");
  }

  const expected = createPortfolioRiskReport(snapshotInput, generatedAt);
  if (JSON.stringify(report) !== JSON.stringify(expected)) {
    throw new PortfolioRiskReportValidationError("Report neodpovídá deterministickému výpočtu ze snapshotu.", "REPORT_MISMATCH");
  }
  return report;
}
