import type { DatabaseMigration } from "../migrate.js";

export const solanaWatchlist: DatabaseMigration = {
  version: 14,
  name: "solana_watchlist",
  up(db) {
    db.exec(`
      ALTER TABLE solana_paper_cycles ADD COLUMN scan_details_json TEXT NOT NULL DEFAULT '{}';
      CREATE TABLE solana_paper_watchlist (
        user_id TEXT NOT NULL REFERENCES solana_paper_accounts(user_id) ON DELETE CASCADE,
        pool_address TEXT NOT NULL,
        mint TEXT NOT NULL,
        symbol TEXT NOT NULL,
        name TEXT NOT NULL,
        decimals INTEGER NOT NULL CHECK (decimals BETWEEN 0 AND 18),
        pool_created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        first_discovered_at INTEGER NOT NULL,
        last_discovered_at INTEGER NOT NULL,
        last_refreshed_at INTEGER NOT NULL,
        last_checked_at INTEGER NOT NULL,
        liquidity_usd REAL NOT NULL CHECK (liquidity_usd >= 0),
        volume_5m_usd REAL NOT NULL CHECK (volume_5m_usd >= 0),
        missing_refreshes INTEGER NOT NULL DEFAULT 0 CHECK (missing_refreshes >= 0),
        PRIMARY KEY (user_id, pool_address),
        CHECK (expires_at > pool_created_at)
      );
      CREATE INDEX solana_paper_watchlist_refresh ON solana_paper_watchlist(user_id,last_checked_at,pool_address);
      CREATE INDEX solana_paper_events_risk_checks ON solana_paper_events(user_id,stage,status,mint,occurred_at);
    `);
  },
};
