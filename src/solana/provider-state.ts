import type { OceanDatabase } from "../db.js";

export type SolanaProviderState = { nextAllowedAt: number; consecutive429: number };

function validateProvider(provider: string) {
  if (provider !== "geckoterminal") throw new Error("Neplatný poskytovatel tržních dat.");
}

/** Provider limits belong to the shared feed, not to an account or an automation run. */
export class SolanaProviderStateStore {
  constructor(readonly db: OceanDatabase) {}

  read(provider: string): SolanaProviderState | undefined {
    validateProvider(provider);
    const row = this.db.prepare("SELECT next_allowed_at,consecutive_429 FROM solana_paper_provider_state WHERE provider=?")
      .get(provider) as { next_allowed_at: number; consecutive_429: number } | undefined;
    return row && { nextAllowedAt: row.next_allowed_at, consecutive429: row.consecutive_429 };
  }

  write(provider: string, state: SolanaProviderState): void {
    validateProvider(provider);
    if (!state || !Number.isSafeInteger(state.nextAllowedAt) || state.nextAllowedAt < 0
      || !Number.isSafeInteger(state.consecutive429) || state.consecutive429 < 0) {
      throw new Error("Neplatný stav omezení poskytovatele tržních dat.");
    }
    // An older request must not erase a newer rate-limit deadline or its failure count.
    // Once the caller has waited until that deadline, a later successful reservation can reset the count.
    this.db.prepare(`INSERT INTO solana_paper_provider_state (provider,next_allowed_at,consecutive_429)
      VALUES (?,?,?) ON CONFLICT(provider) DO UPDATE SET
        next_allowed_at=MAX(solana_paper_provider_state.next_allowed_at,excluded.next_allowed_at),
        consecutive_429=CASE WHEN solana_paper_provider_state.next_allowed_at>excluded.next_allowed_at
          THEN MAX(solana_paper_provider_state.consecutive_429,excluded.consecutive_429)
          ELSE excluded.consecutive_429 END`)
      .run(provider, state.nextAllowedAt, state.consecutive429);
  }
}
