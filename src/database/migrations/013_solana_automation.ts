import type { DatabaseMigration } from "../migrate.js";

export const solanaAutomation: DatabaseMigration = {
  version: 13,
  name: "solana_automation",
  up(db) {
    db.exec(`
      CREATE TABLE solana_paper_automation (
        user_id TEXT PRIMARY KEY REFERENCES solana_paper_accounts(user_id) ON DELETE CASCADE,
        enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
        generation INTEGER NOT NULL DEFAULT 0,
        next_run_at INTEGER,
        last_error TEXT,
        failure_count INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
      ALTER TABLE solana_paper_cycles ADD COLUMN candidate_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE solana_paper_cycles ADD COLUMN risk_checked_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE solana_paper_cycles ADD COLUMN rejected_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE solana_paper_cycles ADD COLUMN candidates_json TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE solana_paper_cycles ADD COLUMN equity_micros INTEGER;
      CREATE INDEX solana_paper_cycles_owner ON solana_paper_cycles(user_id,started_at DESC,id DESC);
    `);
  },
};
