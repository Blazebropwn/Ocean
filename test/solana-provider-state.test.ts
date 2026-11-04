import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/db.js";
import { migrateDatabase } from "../src/database/migrate.js";
import { databaseMigrations } from "../src/database/migrations/index.js";
import { SolanaProviderStateStore, type SolanaProviderState } from "../src/solana/provider-state.js";
import { SolanaPaperStore } from "../src/solana/store.js";

const PROVIDER = "geckoterminal";
const NOW = Date.parse("2026-11-04T19:00:00Z");

test("provider backoff survives restart and is shared by database connections", () => {
  const directory = mkdtempSync(join(tmpdir(), "ocean-provider-state-"));
  const path = join(directory, "pilot.db");
  let db = openDatabase(path);
  let store = new SolanaProviderStateStore(db);
  assert.equal(store.read(PROVIDER), undefined);
  const first = { nextAllowedAt: NOW + 120_000, consecutive429: 1 };
  store.write(PROVIDER, first);
  db.close();
  db = openDatabase(path);
  store = new SolanaProviderStateStore(db);
  const otherDb = openDatabase(path);
  try {
    assert.deepEqual(store.read(PROVIDER), first);
    const otherStore = new SolanaProviderStateStore(otherDb);
    assert.deepEqual(otherStore.read(PROVIDER), first);
    const later = { nextAllowedAt: NOW + 300_000, consecutive429: 2 };
    otherStore.write(PROVIDER, later);
    assert.deepEqual(store.read(PROVIDER), later);
    // A success from an older in-flight request cannot erase a newer response's backoff.
    store.write(PROVIDER, { nextAllowedAt: NOW + 15_000, consecutive429: 0 });
    assert.deepEqual(otherStore.read(PROVIDER), later);
  } finally {
    otherDb.close(); db.close(); rmSync(directory, { recursive: true, force: true });
  }
});

test("provider deadlines never shorten, stale failures are retained, and a later success resets their count", () => {
  const db = openDatabase(":memory:");
  try {
    const store = new SolanaProviderStateStore(db);
    store.write(PROVIDER, { nextAllowedAt: NOW + 300_000, consecutive429: 2 });
    store.write(PROVIDER, { nextAllowedAt: NOW + 120_000, consecutive429: 3 });
    assert.deepEqual(store.read(PROVIDER), { nextAllowedAt: NOW + 300_000, consecutive429: 3 });
    store.write(PROVIDER, { nextAllowedAt: NOW, consecutive429: 0 });
    assert.deepEqual(store.read(PROVIDER), { nextAllowedAt: NOW + 300_000, consecutive429: 3 });
    store.write(PROVIDER, { nextAllowedAt: NOW + 315_000, consecutive429: 0 });
    assert.deepEqual(store.read(PROVIDER), { nextAllowedAt: NOW + 315_000, consecutive429: 0 });
    assert.equal(db.prepare("SELECT COUNT(*) FROM solana_paper_provider_state").pluck().get(), 1);
  } finally { db.close(); }
});

test("account pause, start, manual cycle bookkeeping and account deletion cannot reset a shared provider limit", () => {
  const db = openDatabase(":memory:");
  try {
    db.prepare("INSERT INTO users (id,email,username,password_hash) VALUES ('pilot','pilot@example.invalid','pilot','unused')").run();
    const providerStore = new SolanaProviderStateStore(db);
    const paper = new SolanaPaperStore(db);
    const state = { nextAllowedAt: NOW + 600_000, consecutive429: 3 };
    providerStore.write(PROVIDER, state);
    paper.setAutomation("pilot", true, NOW);
    paper.setAutomation("pilot", false, NOW + 1);
    paper.setAutomation("pilot", true, NOW + 2);
    assert.deepEqual(providerStore.read(PROVIDER), state);
    const cycle = paper.acquire("pilot", NOW + 3);
    paper.finish("pilot", cycle, NOW + 4, true);
    assert.deepEqual(providerStore.read(PROVIDER), state);
    db.prepare("DELETE FROM users WHERE id='pilot'").run();
    assert.deepEqual(providerStore.read(PROVIDER), state);
    assert.deepEqual(db.pragma("foreign_key_check"), []);
  } finally { db.close(); }
});

test("provider state rejects unknown providers and invalid or unsafe integer values without changing stored state", () => {
  const db = openDatabase(":memory:");
  try {
    const store = new SolanaProviderStateStore(db);
    const state = { nextAllowedAt: NOW, consecutive429: 2 };
    store.write(PROVIDER, state);
    for (const provider of ["", "GeckoTerminal", "jupiter", "geckoterminal' OR 1=1 --"]) {
      assert.throws(() => store.read(provider), /poskytovatel/);
      assert.throws(() => store.write(provider, state), /poskytovatel/);
    }
    for (const value of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, "1", null, undefined]) {
      assert.throws(() => store.write(PROVIDER, { ...state, nextAllowedAt: value } as SolanaProviderState), /Neplatný stav/);
      assert.throws(() => store.write(PROVIDER, { ...state, consecutive429: value } as SolanaProviderState), /Neplatný stav/);
    }
    assert.throws(() => store.write(PROVIDER, null as unknown as SolanaProviderState), /Neplatný stav/);
    assert.deepEqual(store.read(PROVIDER), state);
  } finally { db.close(); }
});

test("schema 15 adds infrastructure state without altering paper balances, automation intent or cycle data", () => {
  const db = new Database(":memory:");
  db.pragma("foreign_keys=ON");
  try {
    migrateDatabase(db, databaseMigrations.slice(0, 14));
    db.prepare("INSERT INTO users (id,email,username,password_hash) VALUES ('pilot','pilot@example.invalid','pilot','unused')").run();
    const paper = new SolanaPaperStore(db);
    paper.setAutomation("pilot", true, NOW);
    const cycle = paper.acquire("pilot", NOW);
    paper.finish("pilot", cycle, NOW + 10);
    const accountBefore = db.prepare("SELECT * FROM solana_paper_accounts").get();
    const controlBefore = db.prepare("SELECT * FROM solana_paper_automation").get();
    const cycleBefore = db.prepare("SELECT * FROM solana_paper_cycles").get();
    migrateDatabase(db, databaseMigrations);
    assert.equal(db.prepare("SELECT COUNT(*) FROM solana_paper_provider_state").pluck().get(), 0);
    assert.deepEqual(db.prepare("SELECT * FROM solana_paper_accounts").get(), accountBefore);
    assert.deepEqual(db.prepare("SELECT * FROM solana_paper_automation").get(), controlBefore);
    assert.deepEqual(db.prepare("SELECT * FROM solana_paper_cycles").get(), cycleBefore);
    assert.throws(() => db.prepare("INSERT INTO solana_paper_provider_state VALUES ('geckoterminal',-1,0)").run(), /CHECK/);
    assert.throws(() => db.prepare("INSERT INTO solana_paper_provider_state VALUES ('geckoterminal',0,-1)").run(), /CHECK/);
    assert.deepEqual(db.pragma("foreign_key_check"), []);
  } finally { db.close(); }
});
