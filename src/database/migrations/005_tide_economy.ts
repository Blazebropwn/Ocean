import type { DatabaseMigration } from "../migrate.js";

export const tideEconomy: DatabaseMigration = {
  version: 5,
  name: "tide_economy",
  up(db) {
    db.exec(`
      CREATE TABLE genesis_codes (
        genesis_number INTEGER PRIMARY KEY CHECK (genesis_number BETWEEN 1 AND 100),
        code_hash TEXT NOT NULL UNIQUE CHECK (length(code_hash) = 64),
        created_at TEXT NOT NULL
      );
      CREATE TABLE genesis_redemptions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
        genesis_number INTEGER NOT NULL UNIQUE REFERENCES genesis_codes(genesis_number) ON DELETE RESTRICT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE slot_spins (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 80),
        game_version TEXT NOT NULL CHECK (game_version = 'ocean_slot_v1'),
        bet INTEGER NOT NULL CHECK (bet = 10),
        stops_json TEXT NOT NULL CHECK (json_valid(stops_json) AND json_array_length(stops_json) = 3),
        symbols_json TEXT NOT NULL CHECK (json_valid(symbols_json) AND json_array_length(symbols_json) = 3),
        payout INTEGER NOT NULL CHECK (payout IN (0,30,100,250,1000,10000)),
        balance_before INTEGER NOT NULL CHECK (typeof(balance_before) = 'integer' AND balance_before >= 10 AND balance_before <= 9007199254740991),
        balance_after INTEGER NOT NULL CHECK (typeof(balance_after) = 'integer' AND balance_after >= 0 AND balance_after <= 9007199254740991 AND balance_after = balance_before - bet + payout),
        created_at TEXT NOT NULL,
        UNIQUE (user_id, idempotency_key)
      );
      CREATE INDEX slot_spins_user_created ON slot_spins(user_id, created_at DESC);
      CREATE TABLE tide_ledger (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        amount INTEGER NOT NULL CHECK (typeof(amount) = 'integer'),
        transaction_type TEXT NOT NULL CHECK (transaction_type IN ('GENESIS_REDEMPTION','SLOT_BET','SLOT_WIN')),
        source TEXT NOT NULL CHECK (source IN ('genesis','ocean_slot_v1')),
        reference_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (source, reference_id, transaction_type),
        CHECK ((transaction_type = 'GENESIS_REDEMPTION' AND source = 'genesis' AND amount = 300)
          OR (transaction_type = 'SLOT_BET' AND source = 'ocean_slot_v1' AND amount = -10)
          OR (transaction_type = 'SLOT_WIN' AND source = 'ocean_slot_v1' AND amount IN (30,100,250,1000,10000)))
      );
      CREATE INDEX tide_ledger_user_sequence ON tide_ledger(user_id, sequence DESC);
      CREATE TRIGGER tide_ledger_reference BEFORE INSERT ON tide_ledger BEGIN
        SELECT CASE
          WHEN NEW.source = 'genesis' AND NOT EXISTS (
            SELECT 1 FROM genesis_redemptions WHERE id = NEW.reference_id AND user_id = NEW.user_id
          ) THEN RAISE(ABORT, 'TIDE_INVALID_REFERENCE')
          WHEN NEW.source = 'ocean_slot_v1' AND NOT EXISTS (
            SELECT 1 FROM slot_spins WHERE id = NEW.reference_id AND user_id = NEW.user_id
              AND ((NEW.transaction_type = 'SLOT_BET' AND NEW.amount = -bet)
                OR (NEW.transaction_type = 'SLOT_WIN' AND NEW.amount = payout))
          ) THEN RAISE(ABORT, 'TIDE_INVALID_REFERENCE')
          WHEN NEW.transaction_type = 'SLOT_WIN' AND NOT EXISTS (
            SELECT 1 FROM tide_ledger WHERE reference_id = NEW.reference_id
              AND user_id = NEW.user_id AND transaction_type = 'SLOT_BET'
          ) THEN RAISE(ABORT, 'TIDE_BET_REQUIRED')
        END;
        SELECT CASE WHEN (SELECT COALESCE(SUM(amount),0) FROM tide_ledger WHERE user_id = NEW.user_id) + NEW.amount
          NOT BETWEEN 0 AND 9007199254740991 THEN RAISE(ABORT, 'TIDE_BALANCE_RANGE') END;
      END;
    `);
    for (const table of ["genesis_codes", "genesis_redemptions", "slot_spins", "tide_ledger"]) {
      db.exec(`CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT, 'ECONOMY_IMMUTABLE'); END;
        CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT, 'ECONOMY_IMMUTABLE'); END;`);
    }
  },
};
