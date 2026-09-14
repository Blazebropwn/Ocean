import type { PortfolioSnapshot } from "./contract.js";

export type PortfolioSnapshotRequest = {
  userId: string;
  quoteCurrency: "USDC";
};

export interface PortfolioProvider {
  readonly id: string;
  getSnapshot(input: PortfolioSnapshotRequest): Promise<PortfolioSnapshot>;
}
