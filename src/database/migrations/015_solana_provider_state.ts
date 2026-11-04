import type { DatabaseMigration } from "../migrate.js";

export const solanaProviderState: DatabaseMigration = {
  version: 15,
  name: "solana_provider_state",
  up(db) {
    db.exec(`
      CREATE TABLE solana_paper_provider_state (
        provider TEXT PRIMARY KEY,
        next_allowed_at INTEGER NOT NULL CHECK (next_allowed_at >= 0),
        consecutive_429 INTEGER NOT NULL CHECK (consecutive_429 >= 0)
      );
      -- Preserve an already active legacy 429 pause during this upgrade.
      INSERT INTO solana_paper_provider_state (provider,next_allowed_at,consecutive_429)
        SELECT 'geckoterminal',MAX(next_run_at),MAX(1,MIN(32,MAX(failure_count)))
        FROM solana_paper_automation
        WHERE last_error LIKE '%GeckoTerminal:%HTTP 429%' AND next_run_at IS NOT NULL
        HAVING MAX(next_run_at)>CAST(strftime('%s','now') AS INTEGER)*1000;
    `);
  },
};
