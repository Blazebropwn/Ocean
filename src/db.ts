import Database from "better-sqlite3";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

export type UserRecord = {
  id: string;
  public_id: number;
  email: string;
  username: string;
  password_hash: string;
  email_verified_at: string | null;
  created_at: string;
};

export type PublicUser = {
  id: string;
  displayId: string;
  email: string;
  username: string;
  emailVerified: boolean;
  createdAt: string;
};

export function publicUser(user: UserRecord): PublicUser {
  return {
    id: user.id,
    displayId: `OCEAN-${String(user.public_id).padStart(6, "0")}`,
    email: user.email,
    username: user.username,
    emailVerified: Boolean(user.email_verified_at),
    createdAt: user.created_at,
  };
}

export function openDatabase(path: string) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      public_id INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      email TEXT NOT NULL COLLATE NOCASE UNIQUE,
      username TEXT NOT NULL COLLATE NOCASE UNIQUE,
      password_hash TEXT NOT NULL,
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
  `);
  return db;
}

export type OceanDatabase = ReturnType<typeof openDatabase>;
