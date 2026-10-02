import type { DatabaseMigration } from "../migrate.js";

export const genesisWaves: DatabaseMigration = {
  version: 6,
  name: "genesis_waves",
  up(db) {
    db.exec(`
      CREATE TABLE genesis_waves (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('genesis','promo','legacy')),
        status TEXT NOT NULL CHECK (status IN ('draft','issued')),
        total_codes INTEGER NOT NULL CHECK (total_codes BETWEEN 1 AND 10000),
        code_allocation INTEGER NOT NULL CHECK (typeof(code_allocation)='integer' AND code_allocation > 0),
        admin_allocation INTEGER NOT NULL CHECK (typeof(admin_allocation)='integer' AND admin_allocation >= 0),
        total_supply INTEGER NOT NULL CHECK (typeof(total_supply)='integer' AND total_supply = code_allocation + admin_allocation AND total_supply <= 9007199254740991),
        admin_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
        distribution_json TEXT NOT NULL CHECK (json_valid(distribution_json) AND json_type(distribution_json)='object'),
        digest_key_id TEXT,
        created_at TEXT NOT NULL,
        CHECK ((admin_allocation=0 AND admin_user_id IS NULL) OR (admin_allocation>0 AND admin_user_id IS NOT NULL)),
        CHECK (id <> 'GENESIS_001' OR (kind='genesis' AND total_codes=100 AND code_allocation=75000 AND admin_allocation=25000 AND total_supply=100000))
      );
      CREATE TABLE genesis_codes_v2 (
        id TEXT PRIMARY KEY,
        wave_id TEXT NOT NULL REFERENCES genesis_waves(id) ON DELETE RESTRICT,
        genesis_number INTEGER NOT NULL CHECK (genesis_number > 0),
        code_hash TEXT NOT NULL UNIQUE CHECK (length(code_hash)=64),
        digest_scheme TEXT NOT NULL CHECK (digest_scheme IN ('sha256_legacy','hmac_sha256_v1')),
        reward_tide INTEGER NOT NULL CHECK (typeof(reward_tide)='integer' AND reward_tide > 0),
        created_at TEXT NOT NULL,
        UNIQUE(wave_id,genesis_number), UNIQUE(id,wave_id)
      );
      CREATE TABLE genesis_redemptions_v2 (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        code_id TEXT NOT NULL UNIQUE,
        wave_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (code_id,wave_id) REFERENCES genesis_codes_v2(id,wave_id) ON DELETE RESTRICT,
        UNIQUE(user_id,wave_id)
      );
      INSERT INTO genesis_waves
        SELECT 'LEGACY_300','legacy','issued',COUNT(*),COUNT(*)*300,0,COUNT(*)*300,NULL,
          json_object('300',COUNT(*)),NULL,MIN(created_at) FROM genesis_codes HAVING COUNT(*)>0;
      INSERT INTO genesis_codes_v2 SELECT 'legacy_' || genesis_number,'LEGACY_300',genesis_number,code_hash,'sha256_legacy',300,created_at FROM genesis_codes;
      INSERT INTO genesis_redemptions_v2 SELECT id,user_id,'legacy_' || genesis_number,'LEGACY_300',created_at FROM genesis_redemptions;
      DROP TRIGGER tide_ledger_reference;
      DROP TRIGGER genesis_redemptions_no_delete;
      DROP TRIGGER genesis_codes_no_delete;
      DROP TABLE genesis_redemptions;
      DROP TABLE genesis_codes;
      ALTER TABLE genesis_codes_v2 RENAME TO genesis_codes;
      ALTER TABLE genesis_redemptions_v2 RENAME TO genesis_redemptions;
      CREATE TABLE tide_ledger_v2 (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        amount INTEGER NOT NULL CHECK (typeof(amount)='integer'),
        transaction_type TEXT NOT NULL CHECK (transaction_type IN ('GENESIS_REDEMPTION','GENESIS_ADMIN_ALLOCATION','SLOT_BET','SLOT_WIN')),
        source TEXT NOT NULL CHECK (source IN ('genesis','genesis_admin','ocean_slot_v1')),
        reference_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(source,reference_id,transaction_type),
        CHECK ((transaction_type='GENESIS_REDEMPTION' AND source='genesis' AND amount>0)
          OR (transaction_type='GENESIS_ADMIN_ALLOCATION' AND source='genesis_admin' AND amount>0)
          OR (transaction_type='SLOT_BET' AND source='ocean_slot_v1' AND amount=-10)
          OR (transaction_type='SLOT_WIN' AND source='ocean_slot_v1' AND amount IN (30,100,250,1000,10000)))
      );
      INSERT INTO tide_ledger_v2 SELECT * FROM tide_ledger;
      DROP TRIGGER tide_ledger_no_delete;
      DROP TABLE tide_ledger;
      ALTER TABLE tide_ledger_v2 RENAME TO tide_ledger;
      CREATE INDEX tide_ledger_user_sequence ON tide_ledger(user_id,sequence DESC);
      CREATE INDEX genesis_redemptions_user ON genesis_redemptions(user_id,created_at);
      CREATE TRIGGER tide_ledger_reference BEFORE INSERT ON tide_ledger BEGIN
        SELECT CASE
          WHEN NEW.source='genesis' AND NOT EXISTS (
            SELECT 1 FROM genesis_redemptions r JOIN genesis_codes c ON c.id=r.code_id
            WHERE r.id=NEW.reference_id AND r.user_id=NEW.user_id AND c.reward_tide=NEW.amount
          ) THEN RAISE(ABORT,'TIDE_INVALID_REFERENCE')
          WHEN NEW.source='genesis_admin' AND NOT EXISTS (
            SELECT 1 FROM genesis_waves WHERE id=NEW.reference_id AND admin_user_id=NEW.user_id
              AND admin_allocation=NEW.amount AND status='draft'
          ) THEN RAISE(ABORT,'TIDE_INVALID_REFERENCE')
          WHEN NEW.source='ocean_slot_v1' AND NOT EXISTS (
            SELECT 1 FROM slot_spins WHERE id=NEW.reference_id AND user_id=NEW.user_id
              AND ((NEW.transaction_type='SLOT_BET' AND NEW.amount=-bet) OR (NEW.transaction_type='SLOT_WIN' AND NEW.amount=payout))
          ) THEN RAISE(ABORT,'TIDE_INVALID_REFERENCE')
          WHEN NEW.transaction_type='SLOT_WIN' AND NOT EXISTS (
            SELECT 1 FROM tide_ledger WHERE reference_id=NEW.reference_id AND user_id=NEW.user_id AND transaction_type='SLOT_BET'
          ) THEN RAISE(ABORT,'TIDE_BET_REQUIRED')
        END;
        SELECT CASE WHEN (SELECT COALESCE(SUM(amount),0) FROM tide_ledger WHERE user_id=NEW.user_id) + NEW.amount
          NOT BETWEEN 0 AND 9007199254740991 THEN RAISE(ABORT,'TIDE_BALANCE_RANGE') END;
      END;
      CREATE TRIGGER genesis_wave_insert BEFORE INSERT ON genesis_waves WHEN NEW.status<>'draft' BEGIN SELECT RAISE(ABORT,'GENESIS_DRAFT_REQUIRED'); END;
      CREATE TRIGGER genesis_wave_finalize BEFORE UPDATE ON genesis_waves BEGIN
        SELECT CASE WHEN OLD.status<>'draft' OR NEW.status<>'issued'
          OR NEW.id IS NOT OLD.id OR NEW.kind IS NOT OLD.kind OR NEW.total_codes IS NOT OLD.total_codes
          OR NEW.code_allocation IS NOT OLD.code_allocation OR NEW.admin_allocation IS NOT OLD.admin_allocation
          OR NEW.total_supply IS NOT OLD.total_supply OR NEW.admin_user_id IS NOT OLD.admin_user_id
          OR NEW.distribution_json IS NOT OLD.distribution_json OR NEW.digest_key_id IS NOT OLD.digest_key_id
          OR NEW.created_at IS NOT OLD.created_at THEN RAISE(ABORT,'ECONOMY_IMMUTABLE') END;
        SELECT CASE WHEN (SELECT COUNT(*) FROM genesis_codes WHERE wave_id=NEW.id)<>NEW.total_codes
          OR (SELECT COALESCE(SUM(reward_tide),0) FROM genesis_codes WHERE wave_id=NEW.id)<>NEW.code_allocation
          OR (SELECT COALESCE(SUM(amount),0) FROM tide_ledger WHERE source='genesis_admin' AND reference_id=NEW.id)<>NEW.admin_allocation
          OR EXISTS (SELECT 1 FROM json_each(NEW.distribution_json) tier
            WHERE tier.type<>'integer' OR tier.value<=0 OR (SELECT COUNT(*) FROM genesis_codes WHERE wave_id=NEW.id AND reward_tide=CAST(tier.key AS INTEGER))<>tier.value)
          OR (SELECT SUM(value) FROM json_each(NEW.distribution_json))<>NEW.total_codes
          THEN RAISE(ABORT,'GENESIS_SUPPLY_MISMATCH') END;
      END;
      CREATE TRIGGER genesis_codes_wave BEFORE INSERT ON genesis_codes BEGIN
        SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM genesis_waves WHERE id=NEW.wave_id AND status='draft'
          AND NEW.genesis_number<=total_codes) THEN RAISE(ABORT,'GENESIS_WAVE_CLOSED') END;
      END;
      CREATE TRIGGER genesis_claim BEFORE INSERT ON genesis_redemptions BEGIN
        SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM genesis_waves WHERE id=NEW.wave_id AND status='issued')
          THEN RAISE(ABORT,'GENESIS_WAVE_CLOSED') END;
        SELECT CASE WHEN (SELECT kind FROM genesis_waves WHERE id=NEW.wave_id) IN ('genesis','legacy') AND EXISTS (
          SELECT 1 FROM genesis_redemptions r JOIN genesis_waves w ON w.id=r.wave_id WHERE r.user_id=NEW.user_id AND w.kind IN ('genesis','legacy')
        ) THEN RAISE(ABORT,'GENESIS_IDENTITY_EXISTS') END;
      END;
      CREATE TRIGGER genesis_waves_no_delete BEFORE DELETE ON genesis_waves BEGIN SELECT RAISE(ABORT,'ECONOMY_IMMUTABLE'); END;
    `);
    for (const table of ["genesis_codes", "genesis_redemptions", "tide_ledger"]) {
      db.exec(`CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'ECONOMY_IMMUTABLE'); END;
        CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'ECONOMY_IMMUTABLE'); END;`);
    }
    if ((db.pragma("foreign_key_check") as unknown[]).length) throw new Error("GENESIS_MIGRATION_FOREIGN_KEY_FAILURE");
  },
};
