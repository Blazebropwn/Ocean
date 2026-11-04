import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase, type OceanDatabase } from "../src/db.js";
import { migrateDatabase } from "../src/database/migrate.js";
import { databaseMigrations } from "../src/database/migrations/index.js";
import { SolanaWatchlist, WATCHLIST_MAX_POOLS, WATCHLIST_MAX_REFRESH, WATCHLIST_TTL_MS } from "../src/solana/watchlist.js";
import type { SolanaCandidate } from "../src/solana/types.js";

const NOW = Date.parse("2026-11-04T12:00:00Z");
const OWNER = "usr_watchlist";
const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function address(value: number) {
  let encoded = "";
  do { encoded = alphabet[value % 58] + encoded; value = Math.floor(value / 58); } while (value);
  return encoded.padStart(32, "1");
}
function candidate(index = 1, now = NOW, extra: Partial<SolanaCandidate> = {}): SolanaCandidate {
  return { mint: address(index + 1000), poolAddress: address(index), symbol: `POOL${index}`, name: "Test pool", decimals: 9,
    poolCreatedAt: new Date(NOW - 60_000).toISOString(), observedAt: new Date(now).toISOString(),
    liquidityUsd: 100_000, volume5mUsd: 2_000, evidence: { fixture: true }, ...extra };
}
function account(db: OceanDatabase, userId = OWNER) {
  db.prepare("INSERT INTO users (id,email,username,password_hash) VALUES (?,?,?,'unused')").run(userId, `${userId}@example.invalid`, userId);
  db.prepare("INSERT INTO solana_paper_accounts (user_id,initial_micros,cash_micros,created_at) VALUES (?,100000000,100000000,?)").run(userId, NOW);
}

test("a young discovered pool stays tracked after leaving the discovery pages and matures on fresh data", () => {
  const db = openDatabase(":memory:"); account(db); const watchlist = new SolanaWatchlist(db);
  const initial = candidate(); watchlist.remember(OWNER, [initial], NOW);
  const later = NOW + 6 * 60_000;
  watchlist.remember(OWNER, [], later);
  const due = watchlist.due(OWNER, later);
  assert.equal(due.length, 1);
  assert.equal(due[0]!.poolAddress, initial.poolAddress);
  assert.equal(due[0]!.firstDiscoveredAt, new Date(NOW).toISOString());
  assert.equal(due[0]!.lastDiscoveredAt, new Date(NOW).toISOString());
  const fresh = candidate(1, later, { liquidityUsd: 123_456 });
  assert.deepEqual(watchlist.refreshed(OWNER, [initial.poolAddress], [fresh], later), [fresh]);
  assert.equal(later - Date.parse(fresh.poolCreatedAt), 7 * 60_000);
  assert.deepEqual(watchlist.due(OWNER, later), []);
  assert.equal(watchlist.due(OWNER, later + 60_000)[0]!.lastRefreshedAt, fresh.observedAt);
  assert.equal(watchlist.due(OWNER, later + 60_000)[0]!.lastDiscoveredAt, new Date(NOW).toISOString());
  db.close();
});

test("watchlist admission and capacity are bounded, deterministic, and favor meaningful liquidity", () => {
  const db = openDatabase(":memory:"); account(db); const watchlist = new SolanaWatchlist(db);
  watchlist.remember(OWNER, [candidate(999, NOW, { liquidityUsd: 9_999 })], NOW);
  assert.equal(watchlist.stats(OWNER, NOW).poolCount, 0);
  for (let offset = 0; offset < 180; offset += 60) watchlist.remember(OWNER,
    Array.from({ length: 60 }, (_, index) => candidate(offset + index + 1, NOW, { liquidityUsd: offset + index < 150 ? 20_000 : 50_000 })), NOW);
  assert.equal(watchlist.stats(OWNER, NOW).poolCount, WATCHLIST_MAX_POOLS);
  const rows = db.prepare("SELECT pool_address,liquidity_usd FROM solana_paper_watchlist").all() as { pool_address: string; liquidity_usd: number }[];
  assert.equal(rows.filter(row => row.liquidity_usd === 50_000).length, 30);
  const before = rows.map(row => row.pool_address).sort();
  watchlist.remember(OWNER, Array.from({ length: 60 }, (_, index) => candidate(index + 1, NOW, { liquidityUsd: 20_000 })), NOW);
  assert.deepEqual((db.prepare("SELECT pool_address FROM solana_paper_watchlist ORDER BY pool_address").all() as { pool_address: string }[]).map(row => row.pool_address), before);
  db.close();
});

test("refreshes use a bounded fair queue, exclude fresh discovery, and throttle missing pools", () => {
  const db = openDatabase(":memory:"); account(db); const watchlist = new SolanaWatchlist(db);
  const candidates = Array.from({ length: 60 }, (_, index) => candidate(index + 1));
  watchlist.remember(OWNER, candidates, NOW);
  assert.deepEqual(watchlist.due(OWNER, NOW + 59_999), []);
  const later = NOW + 60_000;
  const excluded = candidates.slice(0, 20).map(row => row.poolAddress);
  const selected = watchlist.due(OWNER, later, excluded, 1_000);
  assert.equal(selected.length, WATCHLIST_MAX_REFRESH);
  assert(selected.every(row => !excluded.includes(row.poolAddress)));
  assert.deepEqual(watchlist.refreshed(OWNER, selected.map(row => row.poolAddress), [], later), []);
  const second = watchlist.due(OWNER, later);
  assert.equal(second.length, WATCHLIST_MAX_REFRESH);
  assert(second.every(row => !selected.some(previous => previous.poolAddress === row.poolAddress)));
  watchlist.refreshed(OWNER, second.map(row => row.poolAddress), [], later);
  const third = watchlist.due(OWNER, later);
  assert.equal(third.length, WATCHLIST_MAX_REFRESH);
  assert(third.every(row => ![...selected, ...second].some(previous => previous.poolAddress === row.poolAddress)));
  watchlist.refreshed(OWNER, third.map(row => row.poolAddress), [], later);
  assert.deepEqual(watchlist.due(OWNER, later), []);
  assert.equal(watchlist.stats(OWNER, later).missingCount, 60);
  assert.equal(watchlist.due(OWNER, later + 60_000).length, WATCHLIST_MAX_REFRESH);
  assert.deepEqual(watchlist.due(OWNER, later + 60_000, [], Number.NaN), []);
  db.close();
});

test("TTL follows immutable pool creation and rediscovery cannot extend it", () => {
  const db = openDatabase(":memory:"); account(db); const watchlist = new SolanaWatchlist(db);
  watchlist.remember(OWNER, [candidate()], NOW);
  const expiry = NOW - 60_000 + WATCHLIST_TTL_MS;
  watchlist.remember(OWNER, [candidate(1, expiry - 1)], expiry - 1);
  assert.equal(watchlist.stats(OWNER, expiry - 1).poolCount, 1);
  assert.equal(watchlist.stats(OWNER, expiry).poolCount, 0);
  assert.deepEqual(watchlist.refreshed(OWNER, [address(1)], [candidate(1, expiry)], expiry), []);
  assert.equal(watchlist.stats(OWNER, expiry).poolCount, 0);
  db.close();
});

test("missing, mismatched and stale refreshes never fall back to a cached candidate", () => {
  const db = openDatabase(":memory:"); account(db); const watchlist = new SolanaWatchlist(db);
  const initial = candidate(); watchlist.remember(OWNER, [initial], NOW);
  const later = NOW + 180_000;
  for (const extra of [
    { mint: address(10_000) }, { poolAddress: address(2) }, { decimals: 8 },
    { poolCreatedAt: new Date(NOW).toISOString() }, { observedAt: initial.observedAt },
    { observedAt: new Date(later + 5_001).toISOString() }, { observedAt: "invalid" },
    { liquidityUsd: Number.NaN }, { volume5mUsd: -1 },
  ]) assert.deepEqual(watchlist.refreshed(OWNER, [initial.poolAddress], [candidate(1, later, extra)], later), []);
  assert.deepEqual(watchlist.refreshed(OWNER, [initial.poolAddress], [], later), []);
  assert.equal(watchlist.stats(OWNER, later).missingCount, 1);
  const fresh = candidate(1, later, { liquidityUsd: 1 });
  // Falling below admission does not erase a known pool, but only its fresh low-liquidity data is returned.
  assert.deepEqual(watchlist.refreshed(OWNER, [initial.poolAddress], [fresh], later), [fresh]);
  assert.equal(watchlist.stats(OWNER, later).missingCount, 0);
  assert.equal(watchlist.stats(OWNER, later).poolCount, 1);
  const changedIdentity = candidate(1, later + 60_000, { mint: address(10_001) });
  watchlist.remember(OWNER, [changedIdentity], later + 60_000);
  assert.equal(watchlist.due(OWNER, later + 60_000)[0]!.mint, initial.mint);
  db.close();
});

test("watchlist persists across restart and stays isolated by account with cascading deletion", () => {
  const directory = mkdtempSync(join(tmpdir(), "ocean-watchlist-")); const path = join(directory, "pilot.db");
  let db = openDatabase(path); account(db); account(db, "usr_other");
  let watchlist = new SolanaWatchlist(db);
  watchlist.remember(OWNER, [candidate(1), candidate(2, NOW, { mint: candidate(1).mint })], NOW);
  watchlist.remember("usr_other", [candidate(1)], NOW);
  db.close(); db = openDatabase(path); watchlist = new SolanaWatchlist(db);
  assert.deepEqual(watchlist.stats(OWNER, NOW), { poolCount: 2, mintCount: 1, missingCount: 0 });
  assert.deepEqual(watchlist.stats("usr_other", NOW), { poolCount: 1, mintCount: 1, missingCount: 0 });
  watchlist.refreshed("usr_other", [address(2)], [candidate(2, NOW + 60_000)], NOW + 60_000);
  assert.equal(watchlist.due(OWNER, NOW + 60_000).length, 2);
  db.prepare("DELETE FROM users WHERE id=?").run(OWNER);
  assert.equal(watchlist.stats(OWNER, NOW).poolCount, 0);
  assert.equal(watchlist.stats("usr_other", NOW).poolCount, 1);
  assert.deepEqual(db.pragma("foreign_key_check"), []);
  db.close(); rmSync(directory, { recursive: true, force: true });
});

test("schema 14 adds empty scan metadata without altering existing paper accounting or cycles", () => {
  const db = new Database(":memory:"); db.pragma("foreign_keys=ON");
  migrateDatabase(db, databaseMigrations.slice(0, 13));
  account(db);
  db.prepare("INSERT INTO solana_paper_cycles (id,user_id,started_at,status) VALUES ('preserved',?,?,'completed')").run(OWNER, NOW);
  migrateDatabase(db, databaseMigrations);
  assert.equal(db.prepare("SELECT scan_details_json FROM solana_paper_cycles WHERE id='preserved'").pluck().get(), "{}");
  assert.equal(db.prepare("SELECT cash_micros FROM solana_paper_accounts WHERE user_id=?").pluck().get(OWNER), 100_000_000);
  assert.equal(db.prepare("SELECT COUNT(*) FROM solana_paper_watchlist").pluck().get(), 0);
  assert.deepEqual(db.pragma("foreign_key_check"), []);
  db.close();
});
