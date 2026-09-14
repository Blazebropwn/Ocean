import type Database from "better-sqlite3";
import type { DatabaseMigration } from "../migrate.js";

function columnNames(db: Database.Database, table: string) {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(({ name }) => name));
}

export const existingOceanSchema: DatabaseMigration = {
  version: 1,
  name: "existing_ocean_schema",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        public_id INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        email TEXT NOT NULL COLLATE NOCASE UNIQUE,
        username TEXT NOT NULL COLLATE NOCASE UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
        email_verified_at TEXT,
        approved_at TEXT,
        approved_by TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        user_agent TEXT,
        ip_address TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sessions_user_id ON sessions(user_id);
      CREATE INDEX IF NOT EXISTS sessions_expires_at ON sessions(expires_at);

      CREATE TABLE IF NOT EXISTS email_verification_tokens (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS email_verification_user_id ON email_verification_tokens(user_id);

      CREATE TABLE IF NOT EXISTS password_reset_tokens (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS password_reset_user_id ON password_reset_tokens(user_id);

      CREATE TABLE IF NOT EXISTS mail_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        recipient TEXT NOT NULL,
        subject TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS security_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        event_type TEXT NOT NULL,
        ip_address TEXT,
        user_agent TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS security_events_user_id ON security_events(user_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS invitations (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        email TEXT COLLATE NOCASE,
        created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at TEXT NOT NULL,
        used_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        used_at TEXT,
        revoked_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS invitations_created_by ON invitations(created_by, created_at DESC);
      CREATE INDEX IF NOT EXISTS invitations_token_hash ON invitations(token_hash);

      CREATE TABLE IF NOT EXISTS kryptotron_instances (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
        remote_state_key TEXT UNIQUE,
        status TEXT NOT NULL DEFAULT 'unconfigured'
          CHECK (status IN ('unconfigured', 'provisioning', 'connected', 'suspended', 'error')),
        environment TEXT NOT NULL DEFAULT 'testnet'
          CHECK (environment IN ('testnet', 'mainnet')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS kryptotron_instances_user_id ON kryptotron_instances(user_id);

      CREATE TABLE IF NOT EXISTS kryptotron_credentials (
        instance_id TEXT PRIMARY KEY REFERENCES kryptotron_instances(id) ON DELETE CASCADE,
        api_key_ciphertext TEXT NOT NULL,
        api_key_iv TEXT NOT NULL,
        api_key_tag TEXT NOT NULL,
        api_secret_ciphertext TEXT NOT NULL,
        api_secret_iv TEXT NOT NULL,
        api_secret_tag TEXT NOT NULL,
        key_version INTEGER NOT NULL DEFAULT 1,
        verified_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS telegram_connections (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        chat_id TEXT NOT NULL UNIQUE,
        telegram_username TEXT,
        connected_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS telegram_pairings (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS telegram_bot_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        update_offset INTEGER NOT NULL DEFAULT 0
      );
      INSERT OR IGNORE INTO telegram_bot_state (id, update_offset) VALUES (1, 0);
    `);

    const users = columnNames(db, "users");
    if (!users.has("role")) db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member'))");
    if (!users.has("approved_at")) db.exec("ALTER TABLE users ADD COLUMN approved_at TEXT");
    if (!users.has("approved_by")) db.exec("ALTER TABLE users ADD COLUMN approved_by TEXT");

    const mailOutbox = columnNames(db, "mail_outbox");
    if (!mailOutbox.has("sent_at")) db.exec("ALTER TABLE mail_outbox ADD COLUMN sent_at TEXT");
    if (!mailOutbox.has("attempts")) db.exec("ALTER TABLE mail_outbox ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0");
    if (!mailOutbox.has("last_error")) db.exec("ALTER TABLE mail_outbox ADD COLUMN last_error TEXT");

    db.prepare(`UPDATE users SET role = 'owner' WHERE public_id = (SELECT MIN(public_id) FROM users) AND NOT EXISTS (SELECT 1 FROM users WHERE role = 'owner')`).run();
    db.prepare(`
      UPDATE users
      SET approved_at = COALESCE(approved_at, created_at),
          approved_by = COALESCE(approved_by, id)
      WHERE role = 'owner'
    `).run();
    db.prepare(`
      INSERT INTO kryptotron_instances (id, user_id, remote_state_key, status, environment)
      SELECT 'kry_' || lower(hex(randomblob(16))), id, 'main', 'connected', 'mainnet'
      FROM users
      WHERE role = 'owner'
        AND NOT EXISTS (SELECT 1 FROM kryptotron_instances WHERE remote_state_key = 'main')
      ORDER BY public_id
      LIMIT 1
    `).run();
  },
};
