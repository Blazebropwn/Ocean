import type { DatabaseMigration } from "../migrate.js";

export const solanaPaper: DatabaseMigration = {
  version: 12,
  name: "solana_paper",
  up(db) {
    db.exec(`
      CREATE TABLE solana_paper_accounts (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        initial_micros INTEGER NOT NULL CHECK (initial_micros = 100000000),
        cash_micros INTEGER NOT NULL CHECK (cash_micros >= 0),
        last_cycle_at INTEGER,
        active_cycle_id TEXT,
        lease_until INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE solana_paper_cycles (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES solana_paper_accounts(user_id) ON DELETE CASCADE,
        started_at INTEGER NOT NULL,
        completed_at INTEGER,
        status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'interrupted'))
      );
      CREATE TABLE solana_paper_positions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES solana_paper_accounts(user_id) ON DELETE CASCADE,
        mint TEXT NOT NULL,
        symbol TEXT NOT NULL,
        token_amount TEXT NOT NULL,
        cost_micros INTEGER NOT NULL CHECK (cost_micros > 0),
        entry_fee_micros INTEGER NOT NULL CHECK (entry_fee_micros >= 0),
        opened_at INTEGER NOT NULL,
        closed_at INTEGER,
        proceeds_micros INTEGER,
        mark_micros INTEGER,
        marked_at INTEGER,
        mark_error TEXT
      );
      CREATE UNIQUE INDEX solana_paper_one_mint ON solana_paper_positions(user_id, mint) WHERE closed_at IS NULL;
      CREATE TABLE solana_paper_trades (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES solana_paper_accounts(user_id) ON DELETE CASCADE,
        position_id TEXT NOT NULL REFERENCES solana_paper_positions(id),
        side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
        token_amount TEXT NOT NULL,
        gross_micros INTEGER NOT NULL CHECK (gross_micros >= 0),
        network_fee_micros INTEGER NOT NULL CHECK (network_fee_micros >= 0),
        quote_json TEXT NOT NULL,
        occurred_at INTEGER NOT NULL
      );
      CREATE TABLE solana_paper_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL REFERENCES solana_paper_accounts(user_id) ON DELETE CASCADE,
        cycle_id TEXT REFERENCES solana_paper_cycles(id),
        stage TEXT NOT NULL,
        status TEXT NOT NULL,
        mint TEXT,
        reason TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        occurred_at INTEGER NOT NULL
      );
      CREATE INDEX solana_paper_events_owner ON solana_paper_events(user_id, sequence DESC);
      CREATE INDEX solana_paper_trades_owner ON solana_paper_trades(user_id, occurred_at DESC);
    `);
  },
};
