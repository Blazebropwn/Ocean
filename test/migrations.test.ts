import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db.js";
import { migrateDatabase, type DatabaseMigration } from "../src/database/migrate.js";

const expectedTables = [
  "email_verification_tokens", "invitations", "kryptotron_credentials", "kryptotron_instances",
  "mail_outbox", "password_reset_tokens", "schema_migrations", "security_events", "sessions",
  "telegram_bot_state", "telegram_connections", "telegram_pairings", "users",
];

test("a new database receives the versioned Ocean schema exactly once", () => {
  const db = openDatabase(":memory:");
  const tables = (db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map(({ name }) => name);
  assert.deepEqual(tables, expectedTables);
  assert.deepEqual(db.prepare("SELECT version, name FROM schema_migrations").all(), [{ version: 1, name: "existing_ocean_schema" }]);
  assert.equal((db.pragma("foreign_keys", { simple: true }) as number), 1);
  db.close();
});

test("reopening a database is idempotent and preserves rows", () => {
  const directory = mkdtempSync(join(tmpdir(), "ocean-migrations-"));
  const path = join(directory, "ocean.db");
  let db = openDatabase(path);
  db.prepare("INSERT INTO users (id, email, username, password_hash) VALUES (?, ?, ?, ?)").run("usr_preserved", "preserved@example.com", "preserved", "hash");
  db.close();

  db = openDatabase(path);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM users WHERE id = 'usr_preserved'").get() as { count: number }).count, 1);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get() as { count: number }).count, 1);
  assert.equal(String(db.pragma("journal_mode", { simple: true })).toLowerCase(), "wal");
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

test("a legacy database is upgraded without losing its owner", () => {
  const directory = mkdtempSync(join(tmpdir(), "ocean-legacy-migration-"));
  const path = join(directory, "legacy.db");
  const legacy = new Database(path);
  legacy.exec(`CREATE TABLE users (public_id INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, email TEXT NOT NULL UNIQUE, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, email_verified_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))); INSERT INTO users (id,email,username,password_hash) VALUES ('usr_legacy','owner@example.com','legacy_owner','hash')`);
  legacy.close();

  const migrated = openDatabase(path);
  const owner = migrated.prepare("SELECT id, role FROM users WHERE id = 'usr_legacy'").get();
  assert.deepEqual(owner, { id: "usr_legacy", role: "owner" });
  assert.equal((migrated.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 1").get() as { count: number }).count, 1);
  migrated.close();
  rmSync(directory, { recursive: true, force: true });
});

test("a failed migration rolls its schema changes back", () => {
  const db = new Database(":memory:");
  const migrations: DatabaseMigration[] = [{
    version: 1,
    name: "fails_atomically",
    up(database) {
      database.exec("CREATE TABLE should_rollback (id INTEGER PRIMARY KEY)");
      throw new Error("intentional failure");
    },
  }];
  assert.throws(() => migrateDatabase(db, migrations), /intentional failure/);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = 'should_rollback'").pluck().get(), 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").pluck().get(), 0);
  db.close();
});

test("a database from an unknown newer schema is rejected", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, applied_at TEXT NOT NULL)");
  db.prepare("INSERT INTO schema_migrations VALUES (2, 'future_schema', datetime('now'))").run();
  assert.throws(() => migrateDatabase(db, [{ version: 1, name: "known", up() {} }]), /neznámou migraci 2/);
  db.close();
});
