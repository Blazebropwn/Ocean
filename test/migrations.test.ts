import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db.js";
import { migrateDatabase, type DatabaseMigration } from "../src/database/migrate.js";

import { databaseMigrations } from "../src/database/migrations/index.js";

const expectedTables = [
  "account_reset_archives",
  "admin_audit_log", "agent_ledger_entries", "agent_runs", "agents", "email_verification_tokens", "genesis_codes", "genesis_redemptions", "genesis_waves", "invitations",
  "kryptotron_credentials", "kryptotron_instances", "mail_outbox", "password_reset_tokens",
  "schema_migrations", "security_events", "sessions", "slot_spins", "sonar_records", "sonar_runs", "telegram_bot_state",
  "telegram_confirmations", "telegram_connections", "telegram_pairings", "tide_ledger", "users", "worker_notifications",
];

test("a new database receives the versioned Ocean schema exactly once", () => {
  const db = openDatabase(":memory:");
  const tables = (db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map(({ name }) => name);
  assert.deepEqual(tables, expectedTables);
  assert.deepEqual(db.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all(), [
    { version: 1, name: "existing_ocean_schema" },
    { version: 2, name: "agent_001_foundation" },
    { version: 3, name: "admin_audit_log" },
    { version: 4, name: "worker_notifications" },
    { version: 5, name: "tide_economy" },
    { version: 6, name: "genesis_waves" },
    { version: 7, name: "account_suspension" },
    { version: 8, name: "sonar_leaderboard" },
    { version: 9, name: "sonar_record_versions" },
    { version: 10, name: "account_reset_archives" },
  ]);
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
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get() as { count: number }).count, 10);
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
  assert.equal((migrated.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 2").get() as { count: number }).count, 1);
  assert.equal((migrated.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 3").get() as { count: number }).count, 1);
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


test("SONAR scoring migration preserves old records and partitions new records by rules", () => {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrateDatabase(db, databaseMigrations.slice(0, 8));
  db.prepare("INSERT INTO users (id,email,username,password_hash) VALUES ('player','player@example.com','player','hash')").run();
  db.prepare("INSERT INTO sonar_records VALUES ('player',2150,25,18,123456)").run();
  migrateDatabase(db, databaseMigrations);
  assert.deepEqual(db.prepare("SELECT * FROM sonar_records").get(), { user_id:'player',version:'sonar-v2',score:2150,hits:25,perfects:18,achieved_at_ms:123456 });
  db.prepare("INSERT INTO sonar_records VALUES ('player','sonar-classic-v1',410,2,2,654321)").run();
  migrateDatabase(db, databaseMigrations);
  assert.equal(db.prepare("SELECT count(*) FROM sonar_records").pluck().get(),2);
  assert.deepEqual(db.pragma("foreign_key_check"),[]);
  db.prepare("DELETE FROM users WHERE id='player'").run();
  assert.equal(db.prepare("SELECT count(*) FROM sonar_records").pluck().get(),0);
  db.close();
});
