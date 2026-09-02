import Database from "better-sqlite3";
import { dirname } from "node:path";
import { chmodSync, mkdirSync } from "node:fs";

export type UserRecord = {
  id: string;
  public_id: number;
  email: string;
  username: string;
  password_hash: string;
  role: "owner" | "member";
  email_verified_at: string | null;
  created_at: string;
};

export type PublicUser = {
  id: string;
  displayId: string;
  email: string;
  username: string;
  emailVerified: boolean;
  role: "owner" | "member";
  createdAt: string;
};

export type KryptotronInstanceRecord = {
  id: string;
  user_id: string;
  remote_state_key: string | null;
  status: "unconfigured" | "provisioning" | "connected" | "suspended" | "error";
  environment: "testnet" | "mainnet";
  created_at: string;
  updated_at: string;
};

export function publicUser(user: UserRecord): PublicUser {
  return {
    id: user.id,
    displayId: `OCEAN-${String(user.public_id).padStart(6, "0")}`,
    email: user.email,
    username: user.username,
    emailVerified: Boolean(user.email_verified_at),
    role: user.role,
    createdAt: user.created_at,
  };
}

export function openDatabase(path: string) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  if (path !== ":memory:") {
    chmodSync(dirname(path), 0o700);
    chmodSync(path, 0o600);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      public_id INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      email TEXT NOT NULL COLLATE NOCASE UNIQUE,
      username TEXT NOT NULL COLLATE NOCASE UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
      email_verified_at TEXT,
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
  `);
  const userColumns = db.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>;
  if (!userColumns.some((column) => column.name === "role")) {
    db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member'))");
  }
  db.prepare(`UPDATE users SET role = 'owner' WHERE public_id = (SELECT MIN(public_id) FROM users) AND NOT EXISTS (SELECT 1 FROM users WHERE role = 'owner')`).run();
  db.prepare(`
    INSERT INTO kryptotron_instances (id, user_id, remote_state_key, status, environment)
    SELECT 'kry_' || lower(hex(randomblob(16))), id, 'main', 'connected', 'mainnet'
    FROM users
    WHERE role = 'owner'
      AND NOT EXISTS (SELECT 1 FROM kryptotron_instances WHERE remote_state_key = 'main')
    ORDER BY public_id
    LIMIT 1
  `).run();
  return db;
}

export type OceanDatabase = ReturnType<typeof openDatabase>;
