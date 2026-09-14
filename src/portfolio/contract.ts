import { z } from "zod";

export const PORTFOLIO_SNAPSHOT_SCHEMA_VERSION = "portfolio.snapshot.v1" as const;
export const PORTFOLIO_SNAPSHOT_STALE_AFTER_MS = 5 * 60 * 1000;
export const PORTFOLIO_PRICE_MAX_AGE_MS = 15 * 60 * 1000;
export const PORTFOLIO_TIMESTAMP_FUTURE_TOLERANCE_MS = 60 * 1000;
// Binance Spot Testnet commonly seeds accounts with hundreds of non-zero assets.
// Keep the payload bounded, but high enough to represent the account without
// silently dropping holdings and producing an incorrect concentration report.
export const PORTFOLIO_MAX_ASSETS = 2_000;

const isoTimestampSchema = z.iso.datetime({ offset: true });
const identifierSchema = z.string().min(3).max(128).regex(/^[a-zA-Z0-9._:-]+$/);
const amountSchema = z.number().finite().nonnegative();

const priceSchema = z
  .object({
    amount: amountSchema,
    quotedIn: z.literal("USDC"),
    source: identifierSchema,
    observedAt: isoTimestampSchema,
  })
  .strict();

const valueSchema = z
  .object({
    amount: amountSchema,
    quotedIn: z.literal("USDC"),
  })
  .strict();

const portfolioAssetSchema = z
  .object({
    asset: z.string().regex(/^[A-Z0-9]{2,16}$/),
    quantity: amountSchema,
    price: priceSchema.nullable(),
    value: valueSchema.nullable(),
  })
  .strict()
  .superRefine((asset, context) => {
    if ((asset.price === null) !== (asset.value === null)) {
      context.addIssue({
        code: "custom",
        message: "Price and value must either both be present or both be null.",
      });
      return;
    }

    if (asset.price && asset.value) {
      const expected = asset.quantity * asset.price.amount;
      const tolerance = Math.max(1e-8, Math.abs(expected) * 1e-8);
      if (Math.abs(asset.value.amount - expected) > tolerance) {
        context.addIssue({
          code: "custom",
          message: "Asset value must equal quantity multiplied by price.",
          path: ["value", "amount"],
        });
      }
    }
  });

export const portfolioSnapshotSchema = z
  .object({
    schemaVersion: z.literal(PORTFOLIO_SNAPSHOT_SCHEMA_VERSION),
    snapshotId: z.string().regex(/^psn_[a-f0-9]{32}$/),
    provider: z
      .object({
        id: identifierSchema,
        source: identifierSchema,
        environment: z.enum(["testnet", "mainnet"]),
        readOnly: z.literal(true),
      })
      .strict(),
    subject: z
      .object({
        userId: z.string().regex(/^usr_[a-f0-9]{32}$/),
        accountRef: identifierSchema,
      })
      .strict(),
    quoteCurrency: z.literal("USDC"),
    capturedAt: isoTimestampSchema,
    status: z.enum(["complete", "partial"]),
    assets: z.array(portfolioAssetSchema).max(PORTFOLIO_MAX_ASSETS),
  })
  .strict()
  .superRefine((snapshot, context) => {
    const seen = new Set<string>();
    for (const [index, asset] of snapshot.assets.entries()) {
      if (seen.has(asset.asset)) {
        context.addIssue({
          code: "custom",
          message: `Asset ${asset.asset} occurs more than once.`,
          path: ["assets", index, "asset"],
        });
      }
      seen.add(asset.asset);
    }

    const hasUnpricedNonzeroAsset = snapshot.assets.some(
      (asset) => asset.quantity > 0 && asset.price === null,
    );
    const expectedStatus = hasUnpricedNonzeroAsset ? "partial" : "complete";
    if (snapshot.status !== expectedStatus) {
      context.addIssue({
        code: "custom",
        message: `Snapshot status must be ${expectedStatus}.`,
        path: ["status"],
      });
    }
  });

export type PortfolioSnapshot = z.infer<typeof portfolioSnapshotSchema>;
export type PortfolioSnapshotFreshness = "fresh" | "stale";

export type ValidatedPortfolioSnapshot = {
  snapshot: PortfolioSnapshot;
  freshness: PortfolioSnapshotFreshness;
};

export class PortfolioSnapshotContractError extends Error {
  constructor(
    message: string,
    readonly code: "FUTURE_TIMESTAMP" | "PRICE_TOO_OLD",
  ) {
    super(message);
    this.name = "PortfolioSnapshotContractError";
  }
}

export function validatePortfolioSnapshot(
  input: unknown,
  now: Date = new Date(),
): ValidatedPortfolioSnapshot {
  const snapshot = portfolioSnapshotSchema.parse(input);
  const nowMs = now.getTime();
  const capturedAtMs = Date.parse(snapshot.capturedAt);

  if (capturedAtMs > nowMs + PORTFOLIO_TIMESTAMP_FUTURE_TOLERANCE_MS) {
    throw new PortfolioSnapshotContractError(
      "Portfolio snapshot timestamp is too far in the future.",
      "FUTURE_TIMESTAMP",
    );
  }

  for (const asset of snapshot.assets) {
    if (!asset.price) continue;
    const observedAtMs = Date.parse(asset.price.observedAt);
    if (observedAtMs > nowMs + PORTFOLIO_TIMESTAMP_FUTURE_TOLERANCE_MS) {
      throw new PortfolioSnapshotContractError(
        `Price timestamp for ${asset.asset} is too far in the future.`,
        "FUTURE_TIMESTAMP",
      );
    }
    const priceAgeMs = nowMs - observedAtMs;
    if (priceAgeMs > PORTFOLIO_PRICE_MAX_AGE_MS) {
      throw new PortfolioSnapshotContractError(
        `Price for ${asset.asset} is too old for a risk report.`,
        "PRICE_TOO_OLD",
      );
    }
  }

  return {
    snapshot,
    freshness:
      nowMs - capturedAtMs > PORTFOLIO_SNAPSHOT_STALE_AFTER_MS ? "stale" : "fresh",
  };
}
