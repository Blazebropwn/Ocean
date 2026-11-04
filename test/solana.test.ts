import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase, type OceanDatabase } from "../src/db.js";
import { buildApp } from "../src/app.js";
import type { Config } from "../src/config.js";
import { hashToken } from "../src/security.js";
import { loadConfig } from "../src/config.js";
import { candidateRejection, candidateRejections, conservativeQuoteAmount, rawAmount, riskRejection, riskRejections, SOLANA_PAPER_POLICY_VERSION, SolanaPaperEngine } from "../src/solana/engine.js";
import { PaperBusyError } from "../src/solana/store.js";
import { SolanaProviderRateLimitError } from "../src/solana/provider-cadence.js";
import { SOLANA_TOKEN_PROGRAM, SOLANA_USDC_MINT, type SolanaCandidate, type SolanaMarketProvider, type SolanaQuote, type SolanaRiskReport } from "../src/solana/types.js";

const OWNER = "usr_solana_pilot";
const MINT = "So11111111111111111111111111111111111111112";
const TOKEN_AMOUNT = "1000000000000000001";
const START = Date.parse("2026-11-04T10:00:00Z");

function insertUser(db: OceanDatabase, id = OWNER) {
  db.prepare("INSERT INTO users (id,email,username,password_hash,approved_at,email_verified_at) VALUES (?,?,?,'unused',datetime('now'),datetime('now'))").run(id, `${id}@example.invalid`, id);
  const token = `session-${id}`;
  db.prepare("INSERT INTO sessions (id_hash,user_id,expires_at) VALUES (?,?,datetime('now','+1 day'))").run(hashToken(token), id);
  return `zero_session=${token}`;
}

function fixture(now: () => number = () => START) {
  const timestamp = () => new Date(now()).toISOString();
  const candidate = (): SolanaCandidate => ({ mint: MINT, poolAddress: SOLANA_TOKEN_PROGRAM, symbol: "PAPER", name: "Fixture only", decimals: 9, poolCreatedAt: new Date(now() - 10 * 60_000).toISOString(), observedAt: timestamp(), liquidityUsd: 100_000, volume5mUsd: 2_000, evidence: { fixture: true } });
  const risk = (): SolanaRiskReport => ({ mint: MINT, observedAt: timestamp(), mintAuthorityRevoked: true, freezeAuthorityRevoked: true, tokenProgram: SOLANA_TOKEN_PROGRAM, topHolderPct: 10, liquidityLockedPct: 99, risks: [], evidence: { fixture: true } });
  const quote = (inputMint: string, outputMint: string, amount: string): SolanaQuote => ({ inputMint, outputMint, inAmount: amount, outAmount: inputMint === SOLANA_USDC_MINT ? TOKEN_AMOUNT : "4900000", minOutAmount: inputMint === SOLANA_USDC_MINT ? TOKEN_AMOUNT : "4900000", quotedAt: timestamp(), expiresAt: null, priceImpactBps: 10, feeBps: 10, feeMint: inputMint, route: "fixture", evidence: { fixture: true, signatureFeeLamports: 5_000, prioritizationFeeLamports: 0, rentFeeLamports: 0 } });
  const provider: SolanaMarketProvider = { async scan() { return [candidate()]; }, async risk() { return risk(); }, async quote(inputMint, outputMint, amount) { return quote(inputMint, outputMint, amount); } };
  return { candidate, risk, quote, provider };
}

test("Solana config has no implicit pilot account or live mode", () => {
  const defaults = loadConfig({});
  assert.equal(defaults.solanaPilotUserId, undefined);
  assert.equal(loadConfig({ OCEAN_SOLANA_PILOT_USER_ID: "  immutable-id  " }).solanaPilotUserId, "immutable-id");
  assert.equal(loadConfig({ OCEAN_SOLANA_PILOT_USER_ID: "  " }).solanaPilotUserId, undefined);
});

test("PAPER gate rejects unknown authorities, concentration, liquidity, warnings and stale pools", () => {
  const f = fixture();
  assert.equal(candidateRejection(f.candidate(), START), null);
  assert.match(candidateRejection({ ...f.candidate(), liquidityUsd: NaN }, START)!, /Likvidita/);
  assert.match(candidateRejection({ ...f.candidate(), poolCreatedAt: new Date(START - 60_000).toISOString() }, START)!, /5 minut/);
  assert.match(candidateRejection({ ...f.candidate(), observedAt: new Date(START - 180_000).toISOString() }, START)!, /zastaralá/);
  assert.equal(riskRejection(f.risk(), MINT, START), null);
  for (const patch of [{ mintAuthorityRevoked: null }, { freezeAuthorityRevoked: null }, { topHolderPct: null }, { liquidityLockedPct: null }, { liquidityLockedPct: 94 }, { tokenProgram: "Token2022" }, { risks: [{ name: "missing report", level: "unknown" }] }, { risks: [{ name: "concentration", level: "warn" }] }]) {
    assert.equal(typeof riskRejection({ ...f.risk(), ...patch }, MINT, START), "string");
  }
});

test("raw token accounting preserves large integer precision and quote fail-closed boundaries", () => {
  const f = fixture();
  const quote = f.quote(SOLANA_USDC_MINT, MINT, "5000000");
  assert.equal(conservativeQuoteAmount(quote, SOLANA_USDC_MINT, MINT, "5000000", START), 990000000000000000n);
  assert.equal(rawAmount(TOKEN_AMOUNT), 1000000000000000001n);
  for (const value of ["0", "1.2", "-1", "1e18", "18446744073709551616", "0001"]) assert.throws(() => rawAmount(value));
  for (const patch of [{ inAmount: "1" }, { minOutAmount: "0" }, { minOutAmount: "18446744073709551615" }, { priceImpactBps: NaN }, { priceImpactBps: 301 }, { feeBps: 101 }, { quotedAt: new Date(START - 31_000).toISOString() }, { expiresAt: new Date(START).toISOString() }, { route: "" }]) {
    assert.throws(() => conservativeQuoteAmount({ ...quote, ...patch }, SOLANA_USDC_MINT, MINT, "5000000", START));
  }
  assert.throws(() => conservativeQuoteAmount({ ...quote, feeBps: 0.5 }, SOLANA_USDC_MINT, MINT, "5000000", START));
  assert.throws(() => conservativeQuoteAmount({ ...quote, feeMint: SOLANA_TOKEN_PROGRAM }, SOLANA_USDC_MINT, MINT, "5000000", START));
  assert.throws(() => conservativeQuoteAmount({ ...quote, evidence: {} }, SOLANA_USDC_MINT, MINT, "5000000", START));
  assert.throws(() => conservativeQuoteAmount({ ...quote, evidence: { signatureFeeLamports: 5_000, prioritizationFeeLamports: 0, rentFeeLamports: 1_000_000_000 } }, SOLANA_USDC_MINT, MINT, "5000000", START));
});

test("PAPER buy, refreshed sell and fees reconcile without any actual execution API", async () => {
  let now = START;
  const db = openDatabase(":memory:"); insertUser(db);
  const f = fixture(() => now);
  const engine = new SolanaPaperEngine(db, f.provider, () => now);
  const bought = await engine.cycle(OWNER, () => true);
  assert.equal(bought.cashUsdc, 94.99);
  assert.equal(bought.positions.length, 1);
  assert.equal(bought.positions[0]!.tokenAmount, "990000000000000000");
  assert.equal(bought.positions[0]!.markUsdc, 4.841);
  assert.equal(bought.trades.length, 1);
  assert.equal(bought.equityUsdc, 99.831);
  assert.equal(db.prepare("SELECT count(*) FROM kryptotron_trade_costs").pluck().get(), 0);
  now += 61_000;
  const sold = await engine.cycle(OWNER, () => true, bought.positions[0]!.id);
  assert.equal(sold.positions.length, 0);
  assert.equal(sold.cashUsdc, 99.831);
  assert.equal(sold.realizedPnlUsdc, -0.169);
  assert.equal(sold.trades.length, 2);
  assert.deepEqual(db.pragma("foreign_key_check"), []);
  db.close();
});

test("failed reverse quote and unknown risk create auditable rejections with no debit", async () => {
  const db = openDatabase(":memory:"); insertUser(db);
  const f = fixture();
  const provider: SolanaMarketProvider = { ...f.provider, async quote(input, output, amount) { if (input === MINT) throw new Error("Žádná prodejní trasa."); return f.quote(input, output, amount); } };
  const engine = new SolanaPaperEngine(db, provider, () => START);
  const snapshot = await engine.cycle(OWNER, () => true);
  assert.equal(snapshot.cashUsdc, 100);
  assert.equal(snapshot.positions.length, 0);
  assert.equal(snapshot.trades.length, 0);
  assert(snapshot.decisions.some((decision) => /prodejní trasa/.test(decision.reason)));
  db.close();
});

test("unpriced position preserves last known value and never fabricates total equity or sale", async () => {
  let now = START;
  let fail = false;
  const db = openDatabase(":memory:"); insertUser(db);
  const f = fixture(() => now);
  const engine = new SolanaPaperEngine(db, { ...f.provider, async quote(input, output, amount) { if (fail) throw new Error("RPC nedostupné."); return f.quote(input, output, amount); } }, () => now);
  const bought = await engine.cycle(OWNER, () => true);
  now += 61_000;
  assert.equal(engine.snapshot(OWNER).equityUsdc, null);
  fail = true;
  await assert.rejects(engine.cycle(OWNER, () => true, bought.positions[0]!.id), /zůstává otevřená/);
  const snapshot = engine.snapshot(OWNER);
  assert.equal(snapshot.equityUsdc, null);
  assert.equal(snapshot.positions.length, 1);
  assert.equal(snapshot.positions[0]!.markUsdc, null);
  assert.equal(snapshot.positions[0]!.lastKnownMarkUsdc, 4.841);
  assert.equal(snapshot.trades.length, 1);
  assert.equal(snapshot.cashUsdc, 94.99);
  db.close();
});

test("durable lease blocks concurrent cycles across engine objects and cooldown survives restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ocean-solana-"));
  const path = join(directory, "paper.db");
  let db = openDatabase(path); insertUser(db);
  const f = fixture();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const first = new SolanaPaperEngine(db, { ...f.provider, async scan() { await pending; return [f.candidate(), f.candidate()]; } }, () => START);
  const running = first.cycle(OWNER, () => true);
  const second = new SolanaPaperEngine(db, f.provider, () => START);
  await assert.rejects(second.cycle(OWNER, () => true), (error) => error instanceof PaperBusyError && error.reason === "running");
  release(); await running;
  assert.equal(first.snapshot(OWNER).positions.length, 1);
  db.close();
  db = openDatabase(path);
  const restarted = new SolanaPaperEngine(db, f.provider, () => START + 10_000);
  assert.equal(restarted.snapshot(OWNER).cashUsdc, 94.99);
  await assert.rejects(restarted.cycle(OWNER, () => true), (error) => error instanceof PaperBusyError && error.reason === "cooldown");
  db.close(); rmSync(directory, { recursive: true, force: true });
});

test("pilot gate checks immutable account ID, login, approval, suspension and origin", async () => {
  const db = openDatabase(":memory:"); const cookie = insertUser(db); const other = insertUser(db, "usr_other");
  const config: Config = { port: 0, host: "127.0.0.1", databasePath: ":memory:", appOrigin: "http://localhost:3000", isProduction: false, manualApprovalEnabled: true, solanaPilotUserId: OWNER };
  const app = buildApp(config, db, { solanaMarketProvider: fixture(Date.now).provider });
  assert.equal((await app.inject({ method: "GET", url: "/api/solana" })).statusCode, 401);
  assert.equal((await app.inject({ method: "GET", url: "/api/solana", headers: { cookie: other } })).statusCode, 404);
  assert.equal((await app.inject({ method: "POST", url: "/api/solana/cycle", headers: { cookie: other } })).statusCode, 404);
  assert.equal((await app.inject({ method: "GET", url: "/api/me", headers: { cookie: other } })).json().user.features.solanaTerminal, false);
  assert.equal((await app.inject({ method: "GET", url: "/api/me", headers: { cookie } })).json().user.features.solanaTerminal, true);
  assert.equal((await app.inject({ method: "GET", url: "/api/solana", headers: { cookie } })).json().initialUsdc, 100);
  assert.equal((await app.inject({ method: "POST", url: "/api/solana/cycle", headers: { cookie, origin: "https://evil.invalid" } })).statusCode, 403);
  assert.equal((await app.inject({ method: "POST", url: "/api/solana/cycle", headers: { cookie }, payload: { mode: "LIVE" } })).statusCode, 400);
  config.solanaPilotUserId = undefined;
  assert.equal((await app.inject({ method: "GET", url: "/api/solana", headers: { cookie } })).statusCode, 404);
  config.solanaPilotUserId = OWNER;
  db.prepare("UPDATE users SET approved_at=NULL WHERE id=?").run(OWNER);
  assert.equal((await app.inject({ method: "GET", url: "/api/solana", headers: { cookie } })).statusCode, 404);
  db.prepare("UPDATE users SET approved_at=datetime('now'),suspended_at=datetime('now') WHERE id=?").run(OWNER);
  assert.equal((await app.inject({ method: "GET", url: "/api/solana", headers: { cookie } })).statusCode, 403);
  assert.equal((await app.inject({ method: "GET", url: "/api/me", headers: { cookie } })).json().user.features.solanaTerminal, false);
  await app.close();
});

test("revoking pilot approval during provider await prevents paper buy", async () => {
  const db = openDatabase(":memory:"); const cookie = insertUser(db);
  const config: Config = { port: 0, host: "127.0.0.1", databasePath: ":memory:", appOrigin: "http://localhost:3000", isProduction: false, manualApprovalEnabled: true, solanaPilotUserId: OWNER };
  const f = fixture(Date.now);
  const provider: SolanaMarketProvider = { ...f.provider, async risk() { db.prepare("UPDATE users SET approved_at=NULL WHERE id=?").run(OWNER); return f.risk(); } };
  const app = buildApp(config, db, { solanaMarketProvider: provider });
  const response = await app.inject({ method: "POST", url: "/api/solana/cycle", headers: { cookie } });
  assert.equal(response.statusCode, 403);
  assert.equal(db.prepare("SELECT cash_micros FROM solana_paper_accounts WHERE user_id=?").pluck().get(OWNER), 100_000_000);
  assert.equal(db.prepare("SELECT count(*) FROM solana_paper_positions").pluck().get(), 0);
  await app.close();
});

test("deleting the pilot cascades all Solana records without touching another account", async () => {
  const db = openDatabase(":memory:"); insertUser(db); insertUser(db, "usr_preserved");
  const engine = new SolanaPaperEngine(db, fixture().provider, () => START);
  await engine.cycle(OWNER, () => true);
  db.prepare("DELETE FROM users WHERE id=?").run(OWNER);
  for (const table of ["accounts", "cycles", "positions", "trades", "events"]) assert.equal(db.prepare(`SELECT count(*) FROM solana_paper_${table}`).pluck().get(), 0);
  assert.equal(db.prepare("SELECT count(*) FROM users WHERE id='usr_preserved'").pluck().get(), 1);
  assert.deepEqual(db.pragma("foreign_key_check"), []);
  db.close();
});

test("each cycle reports only stages actually reached in that cycle", async () => {
  let now = START;
  let scanOnly = false;
  const db = openDatabase(":memory:"); insertUser(db);
  const f = fixture(() => now);
  const engine = new SolanaPaperEngine(db, { ...f.provider, async scan() { return scanOnly ? [] : [f.candidate()]; } }, () => now);
  await engine.cycle(OWNER, () => true);
  now += 61_000; scanOnly = true;
  const snapshot = await engine.cycle(OWNER, () => true);
  for (const stage of ["rug-check", "sizer", "executor"]) assert.equal(snapshot.stages.find((item) => item.id === stage)!.status, "idle");
  assert.equal(snapshot.stages.find((item) => item.id === "scanner")!.status, "ok");
  db.close();
});

test("late quote failures roll back cash, position, trade and executor success as one transaction", async () => {
  const db = openDatabase(":memory:"); insertUser(db);
  db.exec("CREATE TRIGGER abort_solana_trade BEFORE INSERT ON solana_paper_trades BEGIN SELECT RAISE(ABORT,'trade ledger unavailable'); END");
  const engine = new SolanaPaperEngine(db, fixture().provider, () => START);
  const snapshot = await engine.cycle(OWNER, () => true);
  assert.equal(snapshot.cashUsdc, 100);
  assert.equal(snapshot.positions.length, 0);
  assert.equal(snapshot.trades.length, 0);
  assert(!snapshot.decisions.some((decision) => decision.stage === "executor" && decision.status === "ok"));
  assert(snapshot.decisions.some((decision) => /trade ledger unavailable/.test(decision.reason)));
  db.close();
});

test("all account revocations after reverse quote await prevent final commit", async () => {
  for (const mutation of ["suspended", "deleted", "different-pilot", "session-expired"]) {
    const db = openDatabase(":memory:"); const cookie = insertUser(db);
    const config: Config = { port: 0, host: "127.0.0.1", databasePath: ":memory:", appOrigin: "http://localhost:3000", isProduction: false, manualApprovalEnabled: true, solanaPilotUserId: OWNER };
    const f = fixture(Date.now);
    const provider: SolanaMarketProvider = { ...f.provider, async quote(input, output, amount) {
      const quote = f.quote(input, output, amount);
      if (input !== SOLANA_USDC_MINT) {
        if (mutation === "suspended") db.prepare("UPDATE users SET suspended_at=datetime('now') WHERE id=?").run(OWNER);
        if (mutation === "deleted") db.prepare("DELETE FROM users WHERE id=?").run(OWNER);
        if (mutation === "different-pilot") config.solanaPilotUserId = "usr_other";
        if (mutation === "session-expired") db.prepare("UPDATE sessions SET expires_at=datetime('now','-1 day') WHERE user_id=?").run(OWNER);
      }
      return quote;
    } };
    const app = buildApp(config, db, { solanaMarketProvider: provider });
    const response = await app.inject({ method: "POST", url: "/api/solana/cycle", headers: { cookie } });
    assert.equal(response.statusCode, 403, mutation);
    assert.equal(db.prepare("SELECT count(*) FROM solana_paper_positions").pluck().get(), 0, mutation);
    assert.equal(db.prepare("SELECT count(*) FROM solana_paper_trades").pluck().get(), 0, mutation);
    const cash = db.prepare("SELECT cash_micros FROM solana_paper_accounts WHERE user_id=?").pluck().get(OWNER);
    assert.equal(cash, mutation === "deleted" ? undefined : 100_000_000, mutation);
    await app.close();
  }
});

test("exposure and daily loss brakes block fresh tokens without preventing mark refresh", async () => {
  const db = openDatabase(":memory:"); insertUser(db);
  const f = fixture();
  const mints = [MINT, "So11111111111111111111111111111111111111113", "So11111111111111111111111111111111111111114", "So11111111111111111111111111111111111111115"];
  const provider: SolanaMarketProvider = { ...f.provider, async scan() { return mints.map((mint) => ({ ...f.candidate(), mint, poolAddress: mint })); }, async risk(mint) { return { ...f.risk(), mint }; } };
  const engine = new SolanaPaperEngine(db, provider, () => START);
  const snapshot = await engine.cycle(OWNER, () => true);
  assert.equal(snapshot.positions.length, 3);
  assert.equal(snapshot.cashUsdc, 84.97);
  assert.equal(snapshot.positions.reduce((sum, position) => sum + position.costUsdc, 0), 15);
  assert(snapshot.decisions.some((decision) => decision.stage === "sizer" && decision.status === "blocked"));
  db.close();

  const lossDb = openDatabase(":memory:"); insertUser(lossDb);
  const lossEngine = new SolanaPaperEngine(lossDb, f.provider, () => START);
  lossEngine.snapshot(OWNER);
  lossDb.prepare("INSERT INTO solana_paper_positions (id,user_id,mint,symbol,token_amount,cost_micros,entry_fee_micros,opened_at,closed_at,proceeds_micros) VALUES ('previous-loss',?,'previousmint','LOST','1',5000000,10000,?,?,0)").run(OWNER, START - 120_000, START - 60_000);
  lossDb.prepare("UPDATE solana_paper_accounts SET cash_micros=94990000 WHERE user_id=?").run(OWNER);
  assert.equal(lossEngine.store.dailyBraked(OWNER, START), true);
  const blocked = await lossEngine.cycle(OWNER, () => true);
  assert.equal(blocked.positions.length, 0);
  assert.equal(blocked.cashUsdc, 94.99);
  assert(blocked.decisions.some((decision) => decision.stage === "sizer" && decision.status === "blocked"));
  assert.equal(lossEngine.store.dailyBraked(OWNER, START + 24 * 60 * 60_000), false);
  lossDb.close();
});

test("scanner prefilter reaches eligible sixth pool and duplicates cannot starve a fresh token", async () => {
  let now = START;
  let repeated = false;
  const db = openDatabase(":memory:"); insertUser(db);
  const f = fixture(() => now);
  const secondMint = "So11111111111111111111111111111111111111119";
  const riskCalls: string[] = [];
  const provider: SolanaMarketProvider = {
    ...f.provider,
    async scan() {
      if (repeated) return [...Array.from({ length: 5 }, () => f.candidate()), { ...f.candidate(), mint: secondMint, poolAddress: secondMint }];
      const underage = Array.from({ length: 5 }, (_, index) => ({ ...f.candidate(), mint: `So1111111111111111111111111111111111111111${index + 3}`, poolAddress: `So1111111111111111111111111111111111111111${index + 3}`, poolCreatedAt: new Date(now - 60_000).toISOString() }));
      return [...underage, f.candidate()];
    },
    async risk(mint) { riskCalls.push(mint); return { ...f.risk(), mint }; },
  };
  const engine = new SolanaPaperEngine(db, provider, () => now);
  const first = await engine.cycle(OWNER, () => true);
  assert.deepEqual(riskCalls, [MINT]);
  assert.equal(first.positions.length, 1);
  assert.equal(first.positions[0]!.mint, MINT);
  assert(first.decisions.some((decision) => decision.stage === "scanner" && decision.status === "blocked" && /5 minut/.test(decision.reason)));
  now += 61_000;
  repeated = true;
  const second = await engine.cycle(OWNER, () => true);
  assert.deepEqual(riskCalls, [MINT, secondMint]);
  assert.equal(second.positions.length, 2);
  assert.equal(second.cashUsdc, 89.98);
  db.close();
});

test("all observed rejection checks are stored without implying unperformed later checks", async () => {
  const db = openDatabase(":memory:"); insertUser(db);
  const f = fixture();
  const invalid = { ...f.candidate(), poolCreatedAt: new Date(START - 60_000).toISOString(), liquidityUsd: 1, volume5mUsd: 1 };
  assert.equal(candidateRejections(invalid, START).length, 3);
  const badRisk = { ...f.risk(), tokenProgram: "Token2022", topHolderPct: 80, liquidityLockedPct: 0, risks: [{ name: "Unlocked liquidity", level: "danger" }] };
  assert.equal(riskRejections(badRisk, MINT, START).length, 4);
  const engine = new SolanaPaperEngine(db, { ...f.provider, async risk() { return badRisk; } }, () => START);
  const snapshot = await engine.cycle(OWNER, () => true);
  assert.equal(snapshot.candidates[0]!.reasons!.length, 4);
  assert.equal(snapshot.diagnostics.inspectedTokens, 1);
  assert.equal(snapshot.diagnostics.rejectedTokens, 1);
  assert.equal(snapshot.diagnostics.rejectionCounts.length, 4);
  assert.equal(snapshot.diagnostics.policyVersion, SOLANA_PAPER_POLICY_VERSION);
  assert.equal(snapshot.counters.trades, 0);
  assert.equal(snapshot.decisions.some(event => event.stage === "executor"), false);
  db.close();
});

test("a discovered young pool can leave the pages, survive restart, mature and PAPER-buy only after fresh refresh", async () => {
  let now = START;
  const db = openDatabase(":memory:"); insertUser(db);
  const f = fixture(() => now);
  const created = new Date(START - 60_000).toISOString();
  const young = { ...f.candidate(), poolCreatedAt: created };
  const requests: string[][] = [];
  const provider: SolanaMarketProvider = { ...f.provider, async scan() { return now === START ? [young] : []; }, async refreshPools(addresses) { requests.push([...addresses]); return [{ ...f.candidate(), poolCreatedAt: created }]; } };
  const first = await new SolanaPaperEngine(db, provider, () => now).cycle(OWNER, () => true);
  assert.equal(first.watchlist.trackedPools, 1);
  assert.equal(first.counters.trades, 0);
  now += 5 * 60_000;
  const engine = new SolanaPaperEngine(db, provider, () => now);
  const second = await engine.cycle(OWNER, () => true);
  assert.deepEqual(requests, [[young.poolAddress]]);
  assert.equal(second.candidates[0]!.source, "watchlist");
  assert.equal(second.watchlist.refreshedPools, 1);
  assert.equal(second.positions.length, 1);
  assert.equal(second.counters.trades, 1);
  assert.equal(second.cashUsdc, 94.99);
  db.close();
});

test("missing or stale watched data cannot debit cash or reach a risk check", async () => {
  for (const stale of [false, true]) {
    let now = START;
    const db = openDatabase(":memory:"); insertUser(db);
    const f = fixture(() => now);
    const young = { ...f.candidate(), poolCreatedAt: new Date(START - 60_000).toISOString() };
    let riskCalls = 0;
    const provider: SolanaMarketProvider = { ...f.provider, async scan() { return now === START ? [young] : []; }, async refreshPools() { return stale ? [young] : []; }, async risk() { riskCalls++; return f.risk(); } };
    const engine = new SolanaPaperEngine(db, provider, () => now);
    await engine.cycle(OWNER, () => true);
    now += 5 * 60_000;
    await assert.rejects(engine.cycle(OWNER, () => true), /chybí čerstvá/);
    const snapshot = engine.snapshot(OWNER);
    assert.equal(riskCalls, 0);
    assert.equal(snapshot.watchlist.refreshErrors, 1);
    assert.equal(snapshot.cashUsdc, 100);
    assert.equal(snapshot.counters.trades, 0);
    assert.equal(snapshot.candidates.length, 1);
    assert.equal(snapshot.candidateFeed.stale, true);
    assert.equal(snapshot.candidates[0]!.stale, true);
    db.close();
  }
});

test("fresh watched data remains usable during a discovery outage and reports incomplete coverage", async () => {
  let now = START;
  const db = openDatabase(":memory:"); insertUser(db);
  const f = fixture(() => now);
  const created = new Date(START - 60_000).toISOString();
  const provider: SolanaMarketProvider = { ...f.provider, async scan() { if (now !== START) throw new Error("Nové pooly nejsou dostupné."); return [{ ...f.candidate(), poolCreatedAt: created }]; }, async refreshPools() { return [{ ...f.candidate(), poolCreatedAt: created }]; } };
  const engine = new SolanaPaperEngine(db, provider, () => now);
  await engine.cycle(OWNER, () => true);
  now += 5 * 60_000;
  const snapshot = await engine.cycle(OWNER, () => true);
  assert.equal(snapshot.watchlist.lastError, "Nové pooly nejsou dostupné.");
  assert.equal(snapshot.watchlist.refreshedPools, 1);
  assert.equal(snapshot.counters.trades, 1);
  db.close();
});

test("watched refresh runs before discovery and a refresh 429 stops discovery in the same cycle", async () => {
  let now = START;
  const db = openDatabase(":memory:"); insertUser(db);
  const f = fixture(() => now); const calls: string[] = [];
  const young = { ...f.candidate(), poolCreatedAt: new Date(START - 60_000).toISOString() };
  const retryAt = START + 40 * 60_000;
  let riskCalls = 0;
  const provider: SolanaMarketProvider = { ...f.provider,
    async scan() { calls.push("scan"); return [young]; },
    async refreshPools() { calls.push("refresh"); throw new SolanaProviderRateLimitError("GeckoTerminal", retryAt); },
    async risk() { riskCalls++; return f.risk(); },
  };
  const engine = new SolanaPaperEngine(db, provider, () => now);
  try {
    await engine.cycle(OWNER, () => true); now += 5 * 60_000;
    await assert.rejects(engine.cycle(OWNER, () => true), error => error instanceof SolanaProviderRateLimitError && error.retryAt === retryAt);
    assert.deepEqual(calls, ["scan", "refresh"]);
    const state = engine.snapshot(OWNER);
    assert.equal(state.watchlist.refreshErrors, 1); assert.equal(state.diagnostics.inspectedTokens, 0);
    assert.equal(state.candidateFeed.stale, true); assert.equal(state.candidates[0]!.stale, true);
    assert.equal(state.cashUsdc, 100); assert.equal(state.counters.trades, 0); assert.equal(riskCalls, 0);
  } finally { db.close(); }
});

test("fresh watched candidates still reach risk checks and PAPER buy when the following discovery request returns 429", async () => {
  let now = START, limited = false;
  const db = openDatabase(":memory:"); insertUser(db);
  const f = fixture(() => now); const calls: string[] = [];
  const created = new Date(START - 60_000).toISOString();
  const retryAt = START + 40 * 60_000;
  const provider: SolanaMarketProvider = { ...f.provider,
    async scan() {
      calls.push("scan");
      if (now !== START) { limited = true; throw new SolanaProviderRateLimitError("GeckoTerminal", retryAt); }
      return [{ ...f.candidate(), poolCreatedAt: created }];
    },
    async refreshPools() { calls.push("refresh"); return [{ ...f.candidate(), poolCreatedAt: created }]; },
    marketDataStatus() { return { provider: "GeckoTerminal", rateLimited: limited, retryAt: limited ? new Date(retryAt).toISOString() : null }; },
  };
  const engine = new SolanaPaperEngine(db, provider, () => now);
  try {
    await engine.cycle(OWNER, () => true); now += 5 * 60_000;
    const state = await engine.cycle(OWNER, () => true);
    assert.deepEqual(calls, ["scan", "refresh", "scan"]);
    assert.equal(state.watchlist.refreshedPools, 1); assert.match(state.watchlist.lastError!, /HTTP 429/);
    assert.equal(state.marketData.rateLimited, true); assert.equal(state.marketData.retryAt, new Date(retryAt).toISOString());
    assert.equal(state.candidateFeed.stale, false); assert.equal(state.candidates[0]!.source, "watchlist");
    assert.equal(state.candidates[0]!.observedAt, new Date(now).toISOString());
    assert.equal(state.counters.riskChecked, 1); assert.equal(state.counters.trades, 1);
    assert.equal(state.positions.length, 1); assert.equal(state.cashUsdc, 94.99);
  } finally { db.close(); }
});

test("discovery 429 with missing, stale or failed refreshes propagates the typed error and never trades cached watchlist data", async () => {
  for (const outcome of ["missing", "stale", "failed"]) {
    let now = START, riskCalls = 0;
    const db = openDatabase(":memory:"); insertUser(db);
    const f = fixture(() => now); const calls: string[] = [];
    const young = { ...f.candidate(), poolCreatedAt: new Date(START - 60_000).toISOString() };
    const retryAt = START + 40 * 60_000;
    const provider: SolanaMarketProvider = { ...f.provider,
      async scan() { calls.push("scan"); if (now !== START) throw new SolanaProviderRateLimitError("GeckoTerminal", retryAt); return [young]; },
      async refreshPools() { calls.push("refresh"); if (outcome === "failed") throw new Error("Sledované pooly nejsou dostupné."); return outcome === "stale" ? [young] : []; },
      async risk() { riskCalls++; return f.risk(); },
    };
    const engine = new SolanaPaperEngine(db, provider, () => now);
    try {
      await engine.cycle(OWNER, () => true); now += 5 * 60_000;
      await assert.rejects(engine.cycle(OWNER, () => true), error => error instanceof SolanaProviderRateLimitError && error.retryAt === retryAt);
      assert.deepEqual(calls, ["scan", "refresh", "scan"]);
      const state = engine.snapshot(OWNER);
      assert.equal(state.diagnostics.inspectedTokens, 0); assert.equal(state.candidateFeed.stale, true);
      assert.equal(state.cashUsdc, 100); assert.equal(state.positions.length, 0);
      assert.equal(state.counters.trades, 0); assert.equal(riskCalls, 0);
    } finally { db.close(); }
  }
});

test("a newer discovery observation of the same pool supersedes an eligible refresh after liquidity falls", async () => {
  let now = START, riskCalls = 0;
  const db = openDatabase(":memory:"); insertUser(db);
  const f = fixture(() => now); const created = new Date(START - 60_000).toISOString();
  const provider: SolanaMarketProvider = { ...f.provider,
    async refreshPools() { return [{ ...f.candidate(), poolCreatedAt: created, liquidityUsd: 100_000 }]; },
    async scan() {
      if (now === START) return [{ ...f.candidate(), poolCreatedAt: created }];
      now += 7_000;
      return [{ ...f.candidate(), poolCreatedAt: created, liquidityUsd: 49_999 }];
    },
    async risk() { riskCalls++; return f.risk(); },
  };
  const engine = new SolanaPaperEngine(db, provider, () => now);
  try {
    await engine.cycle(OWNER, () => true); now += 5 * 60_000;
    const state = await engine.cycle(OWNER, () => true);
    assert.equal(state.watchlist.refreshedPools, 1);
    assert.equal(state.candidates.length, 1); assert.equal(state.candidates[0]!.source, "discovery");
    assert.equal(state.candidates[0]!.observedAt, new Date(now).toISOString());
    assert.equal(state.candidates[0]!.liquidityUsd, 49_999);
    assert.match(state.candidates[0]!.reason, /Likvidita/);
    assert.equal(state.cashUsdc, 100); assert.equal(state.positions.length, 0);
    assert.equal(state.counters.trades, 0); assert.equal(riskCalls, 0);
  } finally { db.close(); }
});

test("risk budget rotates to unchecked tokens and an eligible pool wins over a younger deeper pool", async () => {
  let now = START;
  const db = openDatabase(":memory:"); insertUser(db);
  const f = fixture(() => now);
  const mints = [..."3456789"].map(char => `So1111111111111111111111111111111111111111${char}`);
  const calls: string[] = [];
  const provider: SolanaMarketProvider = { ...f.provider, async scan() { return mints.map((mint, index) => ({ ...f.candidate(), mint, poolAddress: mint, liquidityUsd: 100_000 - index * 1000 })); }, async risk(mint) { calls.push(mint); return { ...f.risk(), mint, risks: [{ name: "Observed risk", level: "warn" }] }; } };
  const engine = new SolanaPaperEngine(db, provider, () => now);
  await engine.cycle(OWNER, () => true);
  assert.deepEqual(calls, mints.slice(0, 5));
  now += 61_000;
  await engine.cycle(OWNER, () => true);
  assert.deepEqual(calls.slice(5, 7), mints.slice(5));
  assert.equal(new Set(calls).size, 7);
  const mature = f.candidate();
  const withBothPools = new SolanaPaperEngine(db, { ...f.provider, async scan() { return [{ ...mature, poolAddress: SOLANA_USDC_MINT, liquidityUsd: 200_000, poolCreatedAt: new Date(now - 60_000).toISOString() }, mature]; } }, () => now);
  now += 61_000;
  const snapshot = await withBothPools.cycle(OWNER, () => true);
  assert.equal(snapshot.counters.trades, 1);
  db.close();
});
