import assert from "node:assert/strict";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { loadConfig } from "../src/config.js";
import { openDatabase } from "../src/db.js";
import { testnetPreflight } from "../src/testnet-preflight-lib.js";

function fixture(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), "ocean-testnet-preflight-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config = loadConfig({
    DATABASE_PATH: join(dir, "ocean.db"),
    KRYPTOTRON_MAINNET_ENABLED: "false",
    KRYPTOTRON_SUPERVISOR_ENABLED: "true",
    KRYPTOTRON_SUPABASE_URL: "https://private-project.invalid",
    KRYPTOTRON_SUPABASE_KEY: "private-broker-secret",
    OCEAN_CREDENTIALS_KEY: Buffer.alloc(32, 7).toString("base64"),
  });
  const db = openDatabase(config.databasePath);
  db.prepare("INSERT INTO users (id,email,username,password_hash) VALUES ('usr_test','private@email.invalid','private-user','private-hash')").run();
  db.prepare("INSERT INTO kryptotron_instances (id,user_id,remote_state_key,status,environment) VALUES ('kry_test','usr_test','kry_test','connected','testnet')").run();
  db.prepare(`INSERT INTO kryptotron_credentials (instance_id,api_key_ciphertext,api_key_iv,api_key_tag,
    api_secret_ciphertext,api_secret_iv,api_secret_tag,verified_at)
    VALUES ('kry_test','private-key','iv','tag','private-secret','iv','tag',datetime('now'))`).run();
  db.close();
  return config;
}

test("configured testnet reports only local readiness without disclosing credentials or identities", (t) => {
  const config = fixture(t);
  const report = testnetPreflight(config);
  assert.equal(report.status, "CONFIGURED");
  assert.equal(report.liveAcceptance, "NOT_RUN");
  assert.equal(report.scope, "local-configuration-only");
  const output = JSON.stringify(report);
  for (const secret of ["private-", "private@", "kry_test", config.credentialsEncryptionKey!]) {
    assert.equal(output.includes(secret), false);
  }
});

test("enabled mainnet and a mainnet row independently block acceptance configuration", (t) => {
  const config = fixture(t);
  assert.equal(testnetPreflight({ ...config, kryptotronMainnetEnabled: true }).status, "BLOCKED");
  const db = new Database(config.databasePath);
  db.prepare("UPDATE kryptotron_instances SET environment = 'mainnet'").run();
  db.close();
  const report = testnetPreflight(config, "kry_test");
  assert.equal(report.status, "BLOCKED");
  assert.equal(report.checks.find((c) => c.code === "ISOLATED_DATABASE")?.ok, false);
  assert.equal(report.checks.find((c) => c.code === "TESTNET_INSTANCE_SELECTED")?.ok, false);
});

test("missing database is not created and an old schema is not migrated", (t) => {
  const config = fixture(t);
  const missing = join(config.databasePath, "missing.db");
  assert.equal(testnetPreflight({ ...config, databasePath: missing }).status, "BLOCKED");
  assert.equal(existsSync(missing), false);
  const oldPath = config.databasePath + ".old";
  new Database(oldPath).close();
  assert.equal(testnetPreflight({ ...config, databasePath: oldPath }).status, "BLOCKED");
  const db = new Database(oldPath, { readonly: true });
  assert.deepEqual(db.prepare("SELECT name FROM sqlite_master").all(), []);
  db.close();
});

test("legacy state, missing credentials and unapproved access block configuration without writes", (t) => {
  const config = fixture(t);
  const db = new Database(config.databasePath);
  db.prepare("UPDATE kryptotron_instances SET remote_state_key = 'main'").run();
  db.prepare("DELETE FROM kryptotron_credentials").run();
  const before = db.prepare("SELECT * FROM kryptotron_instances").all();
  const report = testnetPreflight({ ...config, manualApprovalEnabled: true });
  for (const code of ["PERSONAL_STATE", "CREDENTIALS_STORED", "ACCESS_APPROVED"]) {
    assert.equal(report.checks.find((c) => c.code === code)?.ok, false);
  }
  assert.deepEqual(db.prepare("SELECT * FROM kryptotron_instances").all(), before);
  db.close();
});

test("multiple testnet instances require explicit selection and unknown IDs fail closed", (t) => {
  const config = fixture(t);
  const db = new Database(config.databasePath);
  db.prepare("INSERT INTO users (id,email,username,password_hash) VALUES ('usr_2','two@email.invalid','two','hash')").run();
  db.prepare("INSERT INTO kryptotron_instances (id,user_id) VALUES ('kry_2','usr_2')").run();
  db.close();
  assert.equal(testnetPreflight(config).status, "BLOCKED");
  assert.equal(testnetPreflight(config, "kry_test").status, "CONFIGURED");
  assert.equal(testnetPreflight(config, "missing").status, "BLOCKED");
});

test("invalid encryption configuration and missing broker block local readiness", (t) => {
  const config = fixture(t);
  assert.equal(testnetPreflight({ ...config, credentialsEncryptionKey: "invalid" }).status, "BLOCKED");
  assert.equal(testnetPreflight({ ...config, kryptotronSupabaseKey: undefined }).status, "BLOCKED");
  assert.equal(testnetPreflight({ ...config, kryptotronSupervisorEnabled: false }).status, "BLOCKED");
});
