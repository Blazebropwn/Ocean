import { randomBytes } from "node:crypto";
import {
  readBinancePortfolio,
  type BinanceEnvironment,
  type BinancePortfolioReadResult,
} from "../binance.js";
import { credentialsKey, decryptCredential } from "../credentials.js";
import type { OceanDatabase } from "../db.js";
import {
  validatePortfolioSnapshot,
  type PortfolioSnapshot,
} from "./contract.js";
import type { PortfolioProvider, PortfolioSnapshotRequest } from "./provider.js";

type StoredPortfolioConnection = {
  id: string;
  user_id: string;
  environment: BinanceEnvironment;
  remote_state_key: string;
  api_key_ciphertext: string | null;
  api_key_iv: string | null;
  api_key_tag: string | null;
  api_secret_ciphertext: string | null;
  api_secret_iv: string | null;
  api_secret_tag: string | null;
};

type WorkerPortfolioSnapshot = {
  schema_version: "ocean.worker-portfolio.v1";
  captured_at: string;
  quote_currency: "USDC";
  assets: Array<{ asset: string; quantity: number; price_usdc: number | null }>;
};

export type LegacyPortfolioReader = (stateKey: string) => Promise<unknown>;

export type BinancePortfolioReader = (
  apiKey: string,
  apiSecret: string,
  environment: BinanceEnvironment,
) => Promise<BinancePortfolioReadResult>;

export class BinancePortfolioProvider implements PortfolioProvider {
  readonly id = "binance-spot";

  constructor(
    private readonly db: OceanDatabase,
    private readonly encryptionKeyValue: string | undefined,
    private readonly reader: BinancePortfolioReader = readBinancePortfolio,
    private readonly now: () => Date = () => new Date(),
    private readonly createSnapshotId: () => string = () => `psn_${randomBytes(16).toString("hex")}`,
    private readonly legacyReader?: LegacyPortfolioReader,
  ) {}

  async getSnapshot(input: PortfolioSnapshotRequest): Promise<PortfolioSnapshot> {
    if (input.quoteCurrency !== "USDC") throw new Error("Binance provider podporuje pouze USDC.");
    const connection = this.db.prepare(`
      SELECT i.id, i.user_id, i.environment, i.remote_state_key,
        c.api_key_ciphertext, c.api_key_iv, c.api_key_tag,
        c.api_secret_ciphertext, c.api_secret_iv, c.api_secret_tag
      FROM kryptotron_instances i
      LEFT JOIN kryptotron_credentials c ON c.instance_id = i.id
      WHERE i.user_id = ? AND i.status = 'connected' AND i.remote_state_key IS NOT NULL
    `).get(input.userId) as StoredPortfolioConnection | undefined;
    if (!connection) throw new Error("Uživatel nemá připojený Binance účet.");

    let portfolio: BinancePortfolioReadResult;
    if (connection.api_key_ciphertext && connection.api_key_iv && connection.api_key_tag
      && connection.api_secret_ciphertext && connection.api_secret_iv && connection.api_secret_tag) {
      const key = credentialsKey(this.encryptionKeyValue);
      const context = `${connection.user_id}:${connection.id}`;
      const apiKey = decryptCredential(
        { ciphertext: connection.api_key_ciphertext, iv: connection.api_key_iv, tag: connection.api_key_tag }, key, `${context}:api-key`,
      );
      const apiSecret = decryptCredential(
        { ciphertext: connection.api_secret_ciphertext, iv: connection.api_secret_iv, tag: connection.api_secret_tag }, key, `${context}:api-secret`,
      );
      portfolio = await this.reader(apiKey, apiSecret, connection.environment);
    } else {
      if (connection.remote_state_key !== "main" || !this.legacyReader) {
        throw new Error("Uživatel nemá připojený Binance účet.");
      }
      const raw = await this.legacyReader(connection.remote_state_key) as { portfolio_snapshot?: WorkerPortfolioSnapshot } | null;
      const snapshot = raw?.portfolio_snapshot;
      if (!snapshot || snapshot.schema_version !== "ocean.worker-portfolio.v1" || snapshot.quote_currency !== "USDC" || !Array.isArray(snapshot.assets)) {
        throw new Error("Hlavní Kryptotron ještě neposkytl portfolio snapshot.");
      }
      portfolio = {
        observedAt: snapshot.captured_at,
        assets: snapshot.assets.map((asset) => ({ asset: asset.asset, quantity: asset.quantity, priceUsdc: asset.price_usdc })),
      };
    }
    const capturedAt = portfolio.observedAt;
    const hasUnpricedNonzeroAsset = portfolio.assets.some(
      (asset) => asset.quantity > 0 && asset.priceUsdc === null,
    );
    const snapshot: PortfolioSnapshot = {
      schemaVersion: "portfolio.snapshot.v1",
      snapshotId: this.createSnapshotId(),
      provider: {
        id: this.id,
        source: "binance",
        environment: connection.environment,
        readOnly: true,
      },
      subject: { userId: connection.user_id, accountRef: connection.id },
      quoteCurrency: "USDC",
      capturedAt,
      status: hasUnpricedNonzeroAsset ? "partial" : "complete",
      assets: portfolio.assets.map((asset) => ({
        asset: asset.asset,
        quantity: asset.quantity,
        price: asset.priceUsdc === null
          ? null
          : { amount: asset.priceUsdc, quotedIn: "USDC", source: "binance-ticker", observedAt: portfolio.observedAt },
        value: asset.priceUsdc === null
          ? null
          : { amount: asset.quantity * asset.priceUsdc, quotedIn: "USDC" },
      })),
    };
    return validatePortfolioSnapshot(snapshot, this.now()).snapshot;
  }
}
