import test from "node:test";
import assert from "node:assert/strict";
import { calculateTradeCosts, unknownTradeCosts, type TradeReference } from "../src/trade-accounting.js";
import { readExecutionEvidence, rememberTradeReference, TradeCostService, type ExecutionEvidence } from "../src/trade-cost-service.js";
import { openDatabase } from "../src/db.js";
import { encryptCredential } from "../src/credentials.js";
import { deriveKryptotronOcto, type KryptotronSnapshot } from "../src/kryptotron.js";

const at = "2026-10-11T05:38:53.977Z";
const reference: TradeReference = { symbol: "BTCUSDC", exitedAt: at, quantity: .99, entryPrice: 100,
  exitPrice: 99.05 / .99, entryOrderId: "1", exitOrderId: "2" };
function evidence(): ExecutionEvidence {
  return [
    { symbol: "BTCUSDC", orderId: 1, side: "BUY", status: "FILLED", executedQty: "1", cummulativeQuoteQty: "100", time: 1 },
    [{ symbol: "BTCUSDC", id: 10, orderId: 1, isBuyer: true, qty: "1", quoteQty: "100", commission: "0.001", commissionAsset: "BTC" }],
    { symbol: "BTCUSDC", orderId: 2, side: "SELL", status: "FILLED", executedQty: "0.99", cummulativeQuoteQty: "99.05", time: 2, updateTime: Date.parse(at) },
    [{ symbol: "BTCUSDC", id: 20, orderId: 2, isBuyer: false, qty: "0.99", quoteQty: "99.05", commission: "0.09905", commissionAsset: "USDC" }],
  ];
}

test("base entry fee, quote exit fee and residual conserve acquisition cost and turn a gross win into a net loss", () => {
  const result = calculateTradeCosts(reference, ...evidence());
  assert.equal(result.status, "verified");
  assert.ok(Math.abs(result.grossPnl! - .05) < 1e-10);
  assert.ok(Math.abs(result.netPnl! - (99.05 - .09905 - 100 * .99 / .999)) < 1e-10);
  assert.equal(result.residualQuantity, .009);
  assert.ok(Math.abs(result.allocatedEntryCost! + result.residualCost! - 100) < 1e-10);
  assert.ok(Math.abs(result.netProceeds! + result.residualCost! - 100 - result.netPnl!) < 1e-10);
  assert.equal(result.entryFees[0]!.amount, .001);
});

test("quote entry fees are part of cost basis; zero fees are known only from complete fills", () => {
  const data = evidence() as any;
  data[1][0].commissionAsset = "USDC"; data[1][0].commission = "0.1";
  const result = calculateTradeCosts(reference, ...data as ExecutionEvidence);
  assert.equal(result.status, "verified");
  assert.ok(Math.abs(result.allocatedEntryCost! - 100.1 * .99) < 1e-10);
  data[1][0].commission = "0"; data[3][0].commission = "0";
  assert.ok(Math.abs(calculateTradeCosts(reference, ...data as ExecutionEvidence).netPnl! - .05) < 1e-10);
  assert.equal(calculateTradeCosts(reference, data[0], [], data[2], []).netPnl, null);
});

test("a base asset exit fee consumes additional inventory without charging it twice", () => {
  const data = evidence() as any;
  data[3][0].commission = "0.001"; data[3][0].commissionAsset = "BTC";
  const result = calculateTradeCosts(reference, ...data as ExecutionEvidence);
  assert.equal(result.status, "verified");
  assert.equal(result.residualQuantity, .008);
  assert.ok(Math.abs(result.netPnl! - (99.05 - 100 * .991 / .999)) < 1e-10);
});

test("unvalued BNB fees preserve original amounts and leave net P/L unknown", () => {
  const data = evidence() as any;
  data[1][0].commissionAsset = "BNB";
  const result = calculateTradeCosts(reference, ...data as ExecutionEvidence);
  assert.equal(result.reason, "UNVALUED_FEE_ASSET");
  assert.equal(result.netPnl, null);
  assert.deepEqual(result.entryFees, [{ asset: "BNB", amount: .001 }]);
});

test("incomplete, duplicate, mismatched or malformed fills cannot claim verified P/L", () => {
  const mutations = [
    (d: any) => { d[1] = []; },
    (d: any) => { d[1].push(d[1][0]); },
    (d: any) => { d[1][0].orderId = 3; },
    (d: any) => { d[1][0].symbol = "ETHUSDC"; },
    (d: any) => { d[3][0].isBuyer = true; },
    (d: any) => { delete d[3][0].commission; },
    (d: any) => { d[3][0].commission = "NaN"; },
    (d: any) => { d[3][0].commission = "-1"; },
    (d: any) => { d[3][0].qty = "0.5"; },
    (d: any) => { d[3][0].quoteQty = "50"; },
    (d: any) => { d[2].status = "PARTIALLY_FILLED"; },
    (d: any) => { d[2].updateTime = 1; },
  ];
  for (const mutate of mutations) {
    const data = evidence(); mutate(data);
    const result = calculateTradeCosts(reference, ...data);
    assert.equal(result.status, "unverified"); assert.equal(result.netPnl, null);
  }
  for (const patch of [{ quantity: .9 }, { entryPrice: 99 }, { exitPrice: 99 }, { entryOrderId: null }]) {
    assert.equal(calculateTradeCosts({ ...reference, ...patch }, ...evidence()).netPnl, null);
  }
});

test("multiple complete fills sum fees and partial terminal buys retain their actual cost", () => {
  const data = evidence() as any;
  data[0].status = "CANCELED";
  data[1] = [
    { ...data[1][0], qty: "0.4", quoteQty: "40", commission: "0.0004" },
    { ...data[1][0], id: 11, qty: "0.6", quoteQty: "60", commission: "0.0006" },
  ];
  assert.deepEqual(calculateTradeCosts(reference, ...data as ExecutionEvidence, new Date(at)), calculateTradeCosts(reference, ...evidence(), new Date(at)));
});

function snapshot(): KryptotronSnapshot {
  return { status: "waiting", lastError: null, entriesPaused: false, positions: [], balance: { asset: "USDC", amount: 100 },
    lastTrade: { ...reference, pnl: .05, result: "WIN" },
    transparency: { trades: [{ ...reference, at, action: "CLOSED", costs: unknownTradeCosts() }] },
  } as unknown as KryptotronSnapshot;
}

function fixture() {
  const db = openDatabase(":memory:"), key = Buffer.alloc(32, 3);
  for (const id of ["one", "two"]) {
    db.prepare("INSERT INTO users(id,email,username,password_hash) VALUES (?,?,?,'hash')").run(id, id + "@example.test", id);
    db.prepare("INSERT INTO kryptotron_instances(id,user_id,status,environment) VALUES (?,?,'connected','testnet')").run(id, id);
    const api = encryptCredential("key-" + id, key, `${id}:${id}:api-key`), secret = encryptCredential("secret-" + id, key, `${id}:${id}:api-secret`);
    db.prepare(`INSERT INTO kryptotron_credentials(instance_id,api_key_ciphertext,api_key_iv,api_key_tag,
      api_secret_ciphertext,api_secret_iv,api_secret_tag,verified_at) VALUES (?,?,?,?,?,?,?,'now')`)
      .run(id, api.ciphertext, api.iv, api.tag, secret.ciphertext, secret.iv, secret.tag);
  }
  const config = { credentialsEncryptionKey: key.toString("base64"), port: 0, host: "127.0.0.1", databasePath: ":memory:", appOrigin: "http://localhost", isProduction: false };
  return { db, config };
}

test("accounting caches evidence across service restarts, deduplicates polls and isolates accounts", async t => {
  const { db, config } = fixture(); t.after(() => db.close());
  let count = 0;
  const reader = async (_: TradeReference, api: string, secret: string, environment: string) => {
    count++; assert.equal(environment, "testnet"); assert.equal(secret, "secret-" + api.slice(4));
    await new Promise(resolve => setTimeout(resolve, 5)); return evidence();
  };
  const service = new TradeCostService(db, config, reader, () => Date.parse(at));
  const [a, b] = await Promise.all([service.enrich("one", snapshot()), service.enrich("one", snapshot())]);
  assert.equal(count, 1); assert.equal(a.lastTrade!.costs!.status, "verified"); assert.deepEqual(a.lastTrade, b.lastTrade);
  const restarted = new TradeCostService(db, config, reader, () => Date.parse(at));
  await restarted.enrich("one", snapshot()); assert.equal(count, 1);
  await restarted.enrich("two", snapshot()); assert.equal(count, 2);
  const last = snapshot(); delete last.lastTrade!.entryOrderId; delete last.lastTrade!.exitOrderId; last.transparency!.trades = [];
  assert.equal((await restarted.enrich("one", last)).lastTrade!.costs!.status, "verified");
  const raw = db.prepare("SELECT * FROM kryptotron_trade_costs").all();
  assert.equal(raw.length, 2); assert.doesNotMatch(JSON.stringify(raw), /secret-|key-one|key-two/);
});

test("failed lookups are throttled, retried and never hide the snapshot or fabricate zero fees", async t => {
  const { db, config } = fixture(); t.after(() => db.close());
  let calls = 0, now = Date.parse(at);
  const service = new TradeCostService(db, config, async () => { calls++; throw Error("secret must not escape"); }, () => now);
  assert.equal((await service.enrich("one", snapshot())).lastTrade!.costs!.reason, "UNAVAILABLE");
  await service.enrich("one", snapshot()); assert.equal(calls, 1);
  now += 60_000; await service.enrich("one", snapshot()); assert.equal(calls, 2);
  assert.doesNotMatch(JSON.stringify(db.prepare("SELECT * FROM kryptotron_trade_costs").all()), /secret must/);
});

test("cached values cannot attach to a changed trade and replay cannot replace verified identities", async t => {
  const { db, config } = fixture(); t.after(() => db.close());
  const service = new TradeCostService(db, config, async () => evidence());
  await service.enrich("one", snapshot());
  rememberTradeReference(db, "one", { ...reference, entryOrderId: "999" });
  const altered = snapshot(); altered.lastTrade!.quantity = .5; altered.transparency!.trades = [];
  assert.equal((await service.enrich("one", altered)).lastTrade!.costs!.netPnl, null);
  assert.equal((await service.enrich("one", snapshot())).lastTrade!.costs!.status, "verified");
});

test("execution reader uses only GET, scopes each order and fills query and retains no credentials", async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  const urls: URL[] = [];
  globalThis.fetch = async (url, init) => {
    assert.equal(init!.method, "GET"); const parsed = new URL(String(url)); urls.push(parsed);
    assert.equal(parsed.origin, "https://testnet.binance.vision");
    assert.equal(parsed.searchParams.get("symbol"), reference.symbol);
    assert.ok(["1", "2"].includes(parsed.searchParams.get("orderId")!));
    return Response.json([]);
  };
  await readExecutionEvidence(reference, "fake-key", "fake-secret", "testnet");
  assert.equal(urls.length, 4);
  assert.ok(urls.every(u => ["/api/v3/order", "/api/v3/myTrades"].includes(u.pathname)));
});

test("mascot uses net result and remains neutral when gross profit has unverified costs", () => {
  const value = snapshot();
  assert.equal(deriveKryptotronOcto(value, Date.parse(at)).state, "idle");
  value.lastTrade!.costs = calculateTradeCosts(reference, ...evidence());
  assert.equal(deriveKryptotronOcto(value, Date.parse(at)).state, "loss");
});

test("an unverifiable recent trade cannot starve older uncached executions", async t => {
  const { db, config } = fixture(); t.after(() => db.close());
  const olderAt = "2026-10-10T05:38:53.977Z";
  const calls: string[] = [];
  let now = Date.parse(at);
  const service = new TradeCostService(db, config, async ref => {
    calls.push(ref.exitedAt);
    if (ref.exitedAt === at) throw Error("Latest exchange evidence is unavailable");
    const data = evidence() as any;
    data[2].updateTime = Date.parse(olderAt);
    return data;
  }, () => now);
  const source = () => {
    const value = snapshot();
    value.transparency!.trades.push({ ...value.transparency!.trades[0]!, at: olderAt });
    return value;
  };
  await service.enrich("one", source());
  now += 60_000;
  const result = await service.enrich("one", source());
  assert.deepEqual(calls, [at, olderAt]);
  assert.equal(result.lastTrade!.costs!.status, "unverified");
  assert.equal(result.transparency!.trades[1]!.costs.status, "verified");
});
