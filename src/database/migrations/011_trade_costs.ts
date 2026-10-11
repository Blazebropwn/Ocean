import type { DatabaseMigration } from "../migrate.js";

export const tradeCosts: DatabaseMigration = {
  version: 11,
  name: "trade_costs",
  up(db) {
    db.exec(`CREATE TABLE kryptotron_trade_costs (
      instance_id TEXT NOT NULL REFERENCES kryptotron_instances(id) ON DELETE CASCADE,
      symbol TEXT NOT NULL,
      exited_at TEXT NOT NULL,
      reference_json TEXT NOT NULL,
      costs_json TEXT,
      evidence_json TEXT,
      checked_at INTEGER,
      PRIMARY KEY (instance_id, symbol, exited_at)
    );`);
  },
};
