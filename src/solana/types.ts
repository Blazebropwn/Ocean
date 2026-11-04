// PAPER-only boundaries. No wallet, private key, transaction or signer belongs here.
export const SOLANA_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const SOLANA_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

export type Evidence = Record<string, unknown>;

export type SolanaCandidate = {
  mint: string;
  poolAddress: string;
  symbol: string;
  name: string;
  decimals: number;
  poolCreatedAt: string;
  observedAt: string;
  liquidityUsd: number;
  volume5mUsd: number;
  evidence: Evidence;
};

export type SolanaRiskReport = {
  mint: string;
  observedAt: string;
  mintAuthorityRevoked: boolean | null;
  freezeAuthorityRevoked: boolean | null;
  tokenProgram: string | null;
  topHolderPct: number | null;
  liquidityLockedPct: number | null;
  risks: { name: string; level: string }[];
  evidence: Evidence;
};

export type SolanaQuote = {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  minOutAmount: string;
  quotedAt: string;
  expiresAt: string | null;
  priceImpactBps: number;
  feeBps: number;
  feeMint: string;
  route: string;
  evidence: Evidence;
};

export interface SolanaMarketProvider {
  scan(): Promise<SolanaCandidate[]>;
  refreshPools?(poolAddresses: readonly string[]): Promise<SolanaCandidate[]>;
  marketDataStatus?(): { provider: string; rateLimited: boolean; retryAt: string | null };
  risk(mint: string): Promise<SolanaRiskReport>;
  quote(inputMint: string, outputMint: string, amount: string): Promise<SolanaQuote>;
}

export type SolanaStage = {
  id: "scanner" | "rug-check" | "sizer" | "executor" | "logger" | "equity";
  status: "idle" | "running" | "ok" | "blocked" | "error";
  detail: string;
};

export type SolanaRuntime = {
  running: boolean;
  cycleId: string | null;
  stage: SolanaStage["id"] | null;
  mint: string | null;
  symbol: string | null;
  detail: string;
  startedAt: string | null;
  updatedAt: string | null;
};

export type SolanaCandidateSummary = {
  mint: string;
  symbol: string;
  liquidityUsd: number;
  volume5mUsd: number;
  observedAt: string;
  status: "eligible" | "blocked" | "checking" | "passed" | "bought";
  reason: string;
  reasons?: string[];
  source?: "discovery" | "watchlist";
  stale?: boolean;
};
