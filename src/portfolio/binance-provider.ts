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
  api_key_ciphertext: string;
  api_key_iv: string;
  api_key_tag: string;
  api_secret_ciphertext: string;
  api_secret_iv: string;
  api_secret_tag: string;
};

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
  ) {}

  async getSnapshot(input: PortfolioSnapshotRequest): Promise<PortfolioSnapshot> {
    if (input.quoteCurrency !== "USDC") throw new Error("Binance provider podporuje pouze USDC.");
    const connection = this.db.prepare(`
      SELECT i.id, i.user_id, i.environment,
        c.api_key_ciphertext, c.api_key_iv, c.api_key_tag,
        c.api_secret_ciphertext, c.api_secret_iv, c.api_secret_tag
      FROM kryptotron_instances i
      JOIN kryptotron_credentials c ON c.instance_id = i.id
      WHERE i.user_id = ? AND i.status = 'connected' AND i.remote_state_key IS NOT NULL
    `).get(input.userId) as StoredPortfolioConnection | undefined;
    if (!connection) throw new Error("Uživatel nemá připojený Binance účet.");

    const key = credentialsKey(this.encryptionKeyValue);
    const context = `${connection.user_id}:${connection.id}`;
    const apiKey = decryptCredential(
      { ciphertext: connection.api_key_ciphertext, iv: connection.api_key_iv, tag: connection.api_key_tag },
      key,
      `${context}:api-key`,
    );
    const apiSecret = decryptCredential(
      { ciphertext: connection.api_secret_ciphertext, iv: connection.api_secret_iv, tag: connection.api_secret_tag },
      key,
      `${context}:api-secret`,
    );
    const portfolio = await this.reader(apiKey, apiSecret, connection.environment);
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
