import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { openDatabase, type OceanDatabase } from "../src/db.js";
import { buildApp } from "../src/app.js";
import type { Config } from "../src/config.js";
import { hashToken } from "../src/security.js";
import { SolanaPaperEngine } from "../src/solana/engine.js";
import { SolanaPaperAutomation } from "../src/solana/automation.js";
import { PublicSolanaMarketProvider } from "../src/solana/providers.js";
import { SolanaProviderStateStore } from "../src/solana/provider-state.js";
import { SolanaProviderRateLimitError } from "../src/solana/provider-cadence.js";
import { migrateDatabase } from "../src/database/migrate.js";
import { databaseMigrations } from "../src/database/migrations/index.js";
import { SolanaPaperStore } from "../src/solana/store.js";
import { SOLANA_USDC_MINT, type SolanaQuote } from "../src/solana/types.js";

const OWNER = "usr_rate_limit_pilot";
const MINT = "vUG3bCjNo3Zf9mPBxU8RJTgjK3ut654QKz4ntvipump";
const POOL = "Fzf5x26QwDpu62w2Js3XTZaDHRzdWB5CRYDt3AKXoaqv";
const SOL = "So11111111111111111111111111111111111111112";
const START = Date.parse("2026-11-04T19:00:00Z");
const RETRY_SECONDS = 40 * 60;

function config(): Config {
  return { port: 0, host: "127.0.0.1", databasePath: ":memory:", appOrigin: "http://localhost:3000",
    isProduction: false, manualApprovalEnabled: true, solanaPilotUserId: OWNER };
}

function user(db: OceanDatabase, id = OWNER) {
  db.prepare("INSERT INTO users(id,email,username,password_hash,approved_at,email_verified_at) VALUES(?,?,?,'unused',datetime('now'),datetime('now'))")
    .run(id, `${id}@example.invalid`, id);
  db.prepare("INSERT INTO sessions(id_hash,user_id,expires_at) VALUES(?,?,datetime('now','+1 day'))").run(hashToken(`rate-${id}`), id);
  return `zero_session=rate-${id}`;
}

function clock(start = START) {
  return { value: start, now() { return this.value; }, async sleep(ms: number) { this.value += ms; } };
}
type Clock = ReturnType<typeof clock>;

function poolFixture() {
  return {
    data: [{ id: `solana_${POOL}`, type: "pool", attributes: {
      address: POOL, pool_created_at: new Date(START - 600_000).toISOString(),
      reserve_in_usd: "29000", volume_usd: { m5: "2000" },
    }, relationships: {
      base_token: { data: { id: `solana_${MINT}`, type: "token" } },
      quote_token: { data: { id: `solana_${SOL}`, type: "token" } },
      dex: { data: { id: "pumpswap", type: "dex" } },
    } }],
    included: [{ id: `solana_${MINT}`, type: "token", attributes: {
      address: MINT, name: "Fixture market", symbol: "FIXTURE", decimals: 6,
    } }],
  };
}

function source(db: OceanDatabase, time: Clock, intervalMs = 7_000) {
  const state = new SolanaProviderStateStore(db);
  const calls: { url: URL; at: number }[] = [];
  const controls = { limited: false, failPage: 1, limitRefresh: false, sellAmount: "4900000" };
  const provider = new PublicSolanaMarketProvider({ now: () => new Date(time.value), sleep: ms => time.sleep(ms),
    geckoIntervalMs: intervalMs, jupiterIntervalMs: 0,
    geckoPersistence: { read: () => state.read("geckoterminal"), write: value => state.write("geckoterminal", value) },
    fetcher: async input => {
      const url = new URL(String(input)); calls.push({ url, at: time.value });
      if (url.hostname === "api.geckoterminal.com") {
        if (controls.limited && (Number(url.searchParams.get("page")) === controls.failPage
          || controls.limitRefresh && url.pathname.includes("/pools/multi/"))) {
          return new Response("must-not-leak-provider-body-or-credential", { status: 429, headers: { "retry-after": String(RETRY_SECONDS) } });
        }
        return Response.json(poolFixture());
      }
      assert.equal(url.hostname, "api.jup.ag");
      const inputMint = url.searchParams.get("inputMint")!;
      const outputMint = url.searchParams.get("outputMint")!;
      return Response.json({ inputMint, outputMint, inAmount: url.searchParams.get("amount"),
        outAmount: controls.sellAmount, otherAmountThreshold: controls.sellAmount, swapMode: "ExactIn",
        priceImpactPct: "0.001", feeBps: 10, feeMint: inputMint, router: "fixture",
        routePlan: [{ swapInfo: { label: "fixture" } }], transaction: null, taker: null,
        signatureFeeLamports: 5000, prioritizationFeeLamports: 0, rentFeeLamports: 0 });
    },
  });
  return { provider, calls, controls, state };
}

test("discovery pages and watched-pool refresh share a paced Gecko queue", async () => {
  const db = openDatabase(":memory:"); const time = clock(); const feed = source(db, time);
  try {
    await feed.provider.scan();
    await feed.provider.scan();
    await feed.provider.scan();
    await feed.provider.refreshPools([POOL]);
    assert.deepEqual(feed.calls.map(call => call.at - START), [0, 7_000, 14_000, 21_000]);
    assert.deepEqual(feed.calls.slice(0, 3).map(call => call.url.searchParams.get("page")), ["1", "5", "10"]);
    assert(feed.calls[3]!.url.pathname.includes("/pools/multi/"));
  } finally { db.close(); }
});

test("a refresh 429 stops same-cycle discovery, preserves the visible feed and recovers only after durable Retry-After", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ocean-rate-limit-")); const path = join(directory, "pilot.db");
  const time = clock(); let db = openDatabase(path); user(db);
  let feed = source(db, time);
  let engine = new SolanaPaperEngine(db, feed.provider, () => time.value);
  let auto = new SolanaPaperAutomation(engine, config(), { now: () => time.value, schedulingEnabled: false });
  try {
    auto.setEnabled(OWNER, true); await auto.tick();
    const initial = auto.snapshot(OWNER);
    assert.equal(initial.candidates.length, 1); assert.equal(initial.candidateFeed.stale, false);
    assert.equal(initial.watchlist.trackedPools, 1); assert.equal(initial.counters.trades, 0);
    time.value = START + 61_000; feed.controls.limited = true; feed.controls.limitRefresh = true;
    const beforeFailure = feed.calls.length; await auto.tick();
    const failed = auto.snapshot(OWNER);
    const failedCalls = feed.calls.slice(beforeFailure);
    assert.equal(failedCalls.length, 1);
    assert(failedCalls[0]!.url.pathname.includes("/pools/multi/"));
    const retryAt = time.value + RETRY_SECONDS * 1000;
    assert.equal(failed.automation.nextRunAt, new Date(retryAt).toISOString());
    assert.equal(failed.marketData.retryAt, failed.automation.nextRunAt);
    assert.equal(failed.marketData.rateLimited, true);
    assert.equal(failed.candidateFeed.stale, true); assert.equal(failed.candidates[0]!.mint, MINT);
    assert.equal(failed.candidates[0]!.stale, true);
    assert.equal(failed.diagnostics.inspectedTokens, 0); assert.equal(failed.diagnostics.rejectedTokens, 0);
    assert.equal(failed.counters.riskChecked, 0); assert.equal(failed.counters.trades, 0);
    const beforeManual = feed.calls.length;
    await assert.rejects(auto.runManual(OWNER, () => true), error => error instanceof SolanaProviderRateLimitError && error.retryAt === retryAt);
    assert.equal(feed.calls.length, beforeManual);
    auto.setEnabled(OWNER, false); auto.setEnabled(OWNER, true); await auto.tick();
    assert.equal(feed.calls.length, beforeManual);
    assert.equal(auto.snapshot(OWNER).automation.nextRunAt, new Date(retryAt).toISOString());
    await auto.close(); db.close(); db = openDatabase(path);
    feed = source(db, time); engine = new SolanaPaperEngine(db, feed.provider, () => time.value);
    auto = new SolanaPaperAutomation(engine, config(), { now: () => time.value, schedulingEnabled: false });
    auto.start(); await auto.tick();
    await assert.rejects(auto.runManual(OWNER, () => true), SolanaProviderRateLimitError);
    assert.equal(feed.calls.length, 0);
    time.value = retryAt - 1; await auto.tick(); assert.equal(feed.calls.length, 0);
    time.value = retryAt; await auto.tick();
    const recovered = auto.snapshot(OWNER);
    assert.equal(feed.calls.length, 2); assert.equal(recovered.marketData.rateLimited, false);
    assert(feed.calls[0]!.url.pathname.includes("/pools/multi/"));
    assert.equal(feed.calls[1]!.url.searchParams.get("page"), "1");
    assert.equal(recovered.candidateFeed.stale, false); assert.equal(recovered.candidates[0]!.stale, false);
    assert.equal(recovered.candidates[0]!.observedAt, new Date(retryAt + 7_000).toISOString());
    assert.equal(recovered.diagnostics.inspectedTokens, 1); assert.equal(recovered.automation.lastError, null);
    assert.equal(feed.state.read("geckoterminal")?.consecutive429, 0);
    assert.equal(recovered.counters.trades, 0);
  } finally { await auto.close(); if (db.open) db.close(); rmSync(directory, { recursive: true, force: true }); }
});

function quote(inputMint: string, outputMint: string, amount: string, now: number): SolanaQuote {
  return { inputMint, outputMint, inAmount: amount, outAmount: "5000000", minOutAmount: "5000000",
    quotedAt: new Date(now).toISOString(), expiresAt: null, priceImpactBps: 10, feeBps: 10, feeMint: inputMint,
    route: "fixture", evidence: { signatureFeeLamports: 5000, prioritizationFeeLamports: 0, rentFeeLamports: 0 } };
}

function position(engine: SolanaPaperEngine, time: Clock) {
  const store = engine.store; const cycleId = store.acquire(OWNER, time.value);
  assert.equal(store.buy({ userId: OWNER, cycleId, mint: MINT, symbol: "FIXTURE", amount: "1000000",
    costMicros: 5_000_000, markMicros: 4_851_000,
    buyQuote: quote(SOLANA_USDC_MINT, MINT, "5000000", time.value), sellQuote: quote(MINT, SOLANA_USDC_MINT, "1000000", time.value),
    now: time.value, authorize: () => true }), true);
  store.finish(OWNER, cycleId, time.value);
  return store.positions(OWNER)[0]!.id;
}

test("Gecko cooldown leaves automatic Jupiter marks and take-profit exits running at their normal cadence", async () => {
  const db = openDatabase(":memory:"); user(db); const time = clock(); const feed = source(db, time);
  const engine = new SolanaPaperEngine(db, feed.provider, () => time.value);
  const auto = new SolanaPaperAutomation(engine, config(), { now: () => time.value, schedulingEnabled: false });
  try {
    position(engine, time);
    const retryAt = START + RETRY_SECONDS * 1000;
    feed.state.write("geckoterminal", { nextAllowedAt: retryAt, consecutive429: 1 });
    time.value += 60_000; auto.setEnabled(OWNER, true);
    assert.equal(auto.snapshot(OWNER).automation.nextRunAt, new Date(time.value).toISOString());
    await auto.tick();
    let state = auto.snapshot(OWNER);
    assert.equal(state.positions.length, 1); assert.equal(state.positions[0]!.markError, null);
    assert.equal(state.positions[0]!.markedAt, new Date(time.value).toISOString());
    assert.equal(state.automation.nextRunAt, new Date(time.value + 60_000).toISOString());
    assert.equal(feed.calls.length, 1); assert.equal(feed.calls[0]!.url.hostname, "api.jup.ag");
    time.value += 60_000; feed.controls.sellAmount = "6200000"; await auto.tick();
    state = auto.snapshot(OWNER);
    assert.equal(state.positions.length, 0); assert.equal(state.counters.trades, 2);
    assert(state.decisions.some(event => /take-profit/.test(event.reason)));
    assert.equal(state.automation.nextRunAt, new Date(retryAt).toISOString());
    assert(feed.calls.every(call => call.url.hostname === "api.jup.ag"));
  } finally { await auto.close(); db.close(); }
});

test("manual close uses Jupiter during Gecko cooldown and its nextCycleAt excludes the source deadline", async () => {
  const db = openDatabase(":memory:"); user(db); const time = clock(); const feed = source(db, time);
  const engine = new SolanaPaperEngine(db, feed.provider, () => time.value);
  const auto = new SolanaPaperAutomation(engine, config(), { now: () => time.value, schedulingEnabled: false });
  try {
    const id = position(engine, time); time.value += 60_000;
    feed.state.write("geckoterminal", { nextAllowedAt: START + RETRY_SECONDS * 1000, consecutive429: 1 });
    assert.equal(engine.snapshot(OWNER).nextCycleAt, new Date(time.value).toISOString());
    const state = await auto.runManual(OWNER, () => true, id);
    assert.equal(state.positions.length, 0); assert.equal(state.counters.trades, 2);
    assert.equal(state.marketData.rateLimited, true);
    assert.deepEqual(feed.calls.map(call => call.url.hostname), ["api.jup.ag"]);
  } finally { await auto.close(); db.close(); }
});

test("rate-limited API returns 429, Retry-After and an owner-only snapshot without leaking the provider response", async () => {
  const db = openDatabase(":memory:"); const cookie = user(db); const other = user(db, "usr_rate_limit_other");
  const time = clock(); const feed = source(db, time, 0); feed.controls.limited = true;
  const app = buildApp(config(), db, { solanaMarketProvider: feed.provider, solanaAutomation: { now: () => time.value, schedulingEnabled: false } });
  try {
    const response = await app.inject({ method: "POST", url: "/api/solana/cycle", headers: { cookie } });
    assert.equal(response.statusCode, 429);
    assert.equal(Number(response.headers["retry-after"]), RETRY_SECONDS);
    assert.equal(response.headers["cache-control"], "no-store");
    const body = response.json();
    assert.equal(body.retryAt, new Date(time.value + RETRY_SECONDS * 1000).toISOString());
    assert.equal(body.snapshot.marketData.rateLimited, true);
    assert.equal(body.snapshot.cashUsdc, 100); assert.equal(body.snapshot.counters.trades, 0);
    assert(!response.body.includes("must-not-leak-provider-body-or-credential"));
    const before = feed.calls.length;
    const repeated = await app.inject({ method: "POST", url: "/api/solana/cycle", headers: { cookie } });
    assert.equal(repeated.statusCode, 429); assert.equal(feed.calls.length, before);
    for (const headers of [{}, { cookie: other }]) {
      const denied = await app.inject({ method: "POST", url: "/api/solana/cycle", headers });
      assert.equal(denied.statusCode, "cookie" in headers ? 404 : 401);
      assert.equal(denied.json().snapshot, undefined); assert.equal(denied.json().retryAt, undefined);
    }
  } finally { await app.close(); }
});

test("migration 15 preserves the longest active legacy Gecko 429 pause and bounds its failure count", () => {
  const db = new Database(":memory:"); db.pragma("foreign_keys=ON");
  try {
    migrateDatabase(db, databaseMigrations.slice(0, 14));
    const now = Date.now(); const deadline = now + 40 * 60_000;
    const store = new SolanaPaperStore(db);
    for (const [id, error, next, failures] of [
      ["limit_short", "GeckoTerminal: HTTP 429", now + 20 * 60_000, 2],
      ["limit_long", "GeckoTerminal: HTTP 429", deadline, 100],
      ["unrelated", "Jupiter: HTTP 429", now + 100 * 60_000, 200],
      ["expired", "GeckoTerminal: HTTP 429", now - 60_000, 3],
    ] as const) {
      user(db, id); store.setAutomation(id, true, now);
      db.prepare("UPDATE solana_paper_automation SET next_run_at=?,last_error=?,failure_count=? WHERE user_id=?")
        .run(next, error, failures, id);
    }
    migrateDatabase(db, databaseMigrations);
    assert.deepEqual(new SolanaProviderStateStore(db).read("geckoterminal"), { nextAllowedAt: deadline, consecutive429: 32 });
    assert.equal(db.prepare("SELECT COUNT(*) FROM solana_paper_provider_state").pluck().get(), 1);
    assert.equal(store.account("limit_long").cash_micros, 100_000_000);
    assert.equal(store.automation("limit_long", now).next_run_at, deadline);
    assert.deepEqual(db.pragma("foreign_key_check"), []);
  } finally { db.close(); }
});
