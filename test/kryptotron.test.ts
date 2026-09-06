import test from "node:test";
import assert from "node:assert/strict";
import { deriveKryptotronOcto, initializeKryptotronInstance, loadKryptotronSnapshot, requestTestDca, setDcaAmount, setDcaEnabled, setKryptotronEntriesPaused } from "../src/kryptotron.js";

const octoSource = (overrides: Partial<Parameters<typeof deriveKryptotronOcto>[0]> = {}): Parameters<typeof deriveKryptotronOcto>[0] => ({
  status: "waiting",
  lastError: null,
  entriesPaused: false,
  positions: [],
  lastTrade: null,
  nextCheckAt: "2026-09-06T10:00:00Z",
  lastMarketCheckAt: null,
  balance: { amount: 73.93, asset: "USDC" },
  ...overrides,
});

test("Octo presents errors before lower-priority trading states", () => {
  const presentation = deriveKryptotronOcto(octoSource({
    status: "degraded",
    lastError: "Binance timeout",
    entriesPaused: true,
    positions: [{ symbol: "BTCUSDC", inPosition: true, entryPrice: 60_000, quantity: 0.01, highestPrice: 61_000, protectionActive: true, protectionStatus: "ACTIVE", protectionPrice: 54_000, protectionActivationPrice: 61_800, protectionTrailingBips: 150 }],
  }));
  assert.equal(presentation.state, "error");
  assert.equal(presentation.critical, true);
  assert.equal(presentation.autoOpen, true);
  assert.doesNotMatch(presentation.message, /Binance timeout/);
});

test("Octo distinguishes protected positions and recent results", () => {
  const protectedPosition = deriveKryptotronOcto(octoSource({
    positions: [{ symbol: "ETHUSDC", inPosition: true, entryPrice: 4_000, quantity: 0.1, highestPrice: 4_100, protectionActive: true, protectionStatus: "ACTIVE", protectionPrice: 3_600, protectionActivationPrice: 4_120, protectionTrailingBips: 150 }],
  }));
  assert.equal(protectedPosition.state, "trade_open");
  assert.equal(protectedPosition.critical, false);

  const exitedAt = "2026-09-06T09:55:00.000Z";
  const loss = deriveKryptotronOcto(octoSource({
    lastTrade: { symbol: "BTCUSDC", entryPrice: 60_000, exitPrice: 59_500, quantity: 0.01, pnl: -5, result: "LOSS", reason: null, enteredAt: null, exitedAt },
  }), Date.parse("2026-09-06T10:00:00.000Z"));
  assert.equal(loss.state, "loss");
  assert.equal(loss.meta, "BTCUSDC · -5.00 USDC");
  assert.equal(loss.eventKey, `trade:${exitedAt}:LOSS`);
});

test("Octo calculates on a fresh market check and settles back to scanning", () => {
  const now = Date.parse("2026-09-06T10:00:00.000Z");
  const active = deriveKryptotronOcto(octoSource({
    status: "waiting",
    lastMarketCheckAt: "2026-09-06T09:59:40.000Z",
  }), now);
  assert.equal(active.state, "calculating");
  assert.equal(active.autoOpen, false);
  assert.equal(active.critical, false);

  const settled = deriveKryptotronOcto(octoSource({
    status: "running",
    lastMarketCheckAt: "2026-09-06T09:55:00.000Z",
  }), now);
  assert.equal(settled.state, "scanning");
});

test("Octo does not celebrate stale trades and clears recovered errors", () => {
  const stale = deriveKryptotronOcto(octoSource({
    lastTrade: { symbol: "BTCUSDC", entryPrice: 60_000, exitPrice: 61_000, quantity: 0.01, pnl: 10, result: "WIN", reason: null, enteredAt: null, exitedAt: "2026-09-06T09:00:00.000Z" },
  }), Date.parse("2026-09-06T10:00:00.000Z"));
  assert.equal(stale.state, "idle");
  assert.equal(stale.critical, false);

  const recovered = deriveKryptotronOcto(octoSource({ status: "waiting", lastError: null }));
  assert.equal(recovered.state, "idle");
  assert.equal(recovered.critical, false);
  assert.equal(recovered.autoOpen, false);
});

test("new Kryptotron instances receive an isolated paused state", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (_input, init) => {
    const payload = JSON.parse(String(init?.body)) as { key: string; data: Record<string, unknown> };
    assert.equal(payload.key, "kry_0123456789abcdef0123456789abcdef");
    assert.equal(payload.data.environment, "testnet");
    assert.equal(payload.data.entries_paused, true);
    return new Response(null, { status: 201 });
  };
  assert.equal(
    await initializeKryptotronInstance("https://example.supabase.co", "key", "kry_0123456789abcdef0123456789abcdef", "testnet"),
    "kry_0123456789abcdef0123456789abcdef",
  );
});

test("maps Kryptotron state and latest trade into the Ocean contract", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const urls: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    urls.push(url);
    const body = url.includes("bot_state") ? [{
      data: { runtime_status: "waiting", entries_paused: true, last_heartbeat_at: new Date().toISOString(), last_market_check_at: "2026-08-22T08:00:00Z", next_check_at: "2026-08-22T12:00:00Z", account_balance: 73.93, quote_asset: "USDC", dca: { enabled: true, amount: 5, symbols: ["BTCUSDC", "ETHUSDC", "SOLUSDC"], completed_week: "2026-W33", purchases: [{ symbol: "BTCUSDC", amount: 5, quantity: 0.0001 }, { symbol: "ETHUSDC", amount: 5, quantity: 0.002 }] }, events: [{ type: "MARKET", message: "Trh zkontrolován", at: "2026-08-22T08:00:00Z" }], positions: { BTCUSDC: { in_position: true, entry_price: 68000, position_qty: 0.001, highest_price: 70000, protection_status: "ACTIVE", protection_stop_price: 61200, protection_activation_price: 70040, protection_trailing_bips: 150 } }, daily_loss: 1, weekly_loss: 2, trades_today: 1, trades_week: 3 },
      updated_at: "2026-08-22T08:00:00Z",
    }] : [{ symbol: "BTCUSDC", entry_price: 65000, exit_price: 67000, qty: 0.001, pnl: 2, result: "WIN", reason: "TRAIL_SL", entry_time: "2026-08-20T08:00:00Z", exit_time: "2026-08-21T08:00:00Z" }];
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };

  const snapshot = await loadKryptotronSnapshot("https://example.supabase.co", "key");
  assert.equal(snapshot.connected, true);
  assert.equal(snapshot.status, "waiting");
  assert.equal(snapshot.entriesPaused, true);
  assert.deepEqual(snapshot.events[0], { type: "MARKET", message: "Trh zkontrolován", at: "2026-08-22T08:00:00Z" });
  assert.equal(snapshot.nextCheckAt, "2026-08-22T12:00:00Z");
  assert.deepEqual(snapshot.balance, { amount: 73.93, asset: "USDC" });
  assert.equal(snapshot.dca.enabled, true);
  assert.equal(snapshot.dca.totalInvested, 10);
  assert.equal(snapshot.dca.purchaseCount, 2);
  assert.equal(snapshot.dca.testStatus, null);
  assert.deepEqual(snapshot.dca.progress[0], { symbol: "BTCUSDC", asset: "BTC", quantity: 0.0001, target: 1, percentage: 0.01 });
  assert.equal(snapshot.positions[0]?.protectionActive, true);
  assert.equal(snapshot.positions[0]?.protectionStatus, "ACTIVE");
  assert.equal(snapshot.positions[0]?.protectionPrice, 61200);
  assert.equal(snapshot.positions[0]?.protectionActivationPrice, 70040);
  assert.equal(snapshot.positions[0]?.protectionTrailingBips, 150);
  assert.equal(snapshot.octo.state, "trade_open");
  assert.equal(snapshot.octo.critical, false);
  assert.match(snapshot.octo.message, /BTCUSDC/);
  assert.equal(snapshot.limits.tradesWeek, 3);
  assert.equal(snapshot.lastTrade?.reason, "TRAIL_SL");
  assert.ok(urls.some((url) => url.includes("bot_trades?instance_id=eq.main")));
});

test("DCA amount control preserves the module and records the preset", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const requests: Array<{ method: string; body?: string }> = [];
  globalThis.fetch = async (_input, init) => {
    requests.push({ method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : undefined });
    if (!init?.method) return new Response(JSON.stringify([{ data: { dca: { enabled: true, amount: 5, symbols: ["BTCUSDC"] }, events: [] } }]), { status: 200 });
    return new Response(null, { status: 204 });
  };
  assert.equal(await setDcaAmount("https://example.supabase.co", "key", 20), 20);
  const patch = JSON.parse(requests[1]?.body ?? "{}");
  assert.deepEqual(patch.data.dca, { enabled: true, amount: 20, symbols: ["BTCUSDC"] });
  assert.equal(patch.data.events[0].message, "DCA preset změněn na 20 USDC");
});

test("Kryptotron requests use only the assigned remote state key", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const urls: string[] = [];
  globalThis.fetch = async (input, init) => {
    urls.push(String(input));
    if (!init?.method) return new Response(JSON.stringify([{ data: { dca: { enabled: false } } }]), { status: 200 });
    return new Response(null, { status: 204 });
  };

  await setDcaEnabled("https://example.supabase.co", "key", true, "usr_alpha/state");
  assert.equal(urls.length, 2);
  assert.ok(urls.every((url) => url.includes("key=eq.usr_alpha%2Fstate")));
  assert.ok(urls.every((url) => !url.includes("key=eq.main")));
});

test("pause control preserves the worker state and changes only new entries", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const requests: Array<{ method: string; body?: string }> = [];
  globalThis.fetch = async (_input, init) => {
    requests.push({ method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : undefined });
    if (!init?.method) return new Response(JSON.stringify([{ data: { runtime_status: "waiting", account_balance: 73.93 } }]), { status: 200 });
    return new Response(null, { status: 204 });
  };

  assert.equal(await setKryptotronEntriesPaused("https://example.supabase.co", "key", true), true);
  assert.equal(requests[0]?.method, "GET");
  assert.equal(requests[1]?.method, "PATCH");
  const patch = JSON.parse(requests[1]?.body ?? "{}");
  assert.equal(patch.data.entries_paused, true);
  assert.equal(patch.data.runtime_status, "waiting");
  assert.equal(patch.data.account_balance, 73.93);
  assert.equal(patch.data.events[0].type, "CONTROL");
  assert.equal(patch.data.events[0].message, "Nové obchody pozastaveny");
});

test("DCA control preserves its configuration and changes only enabled state", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const requests: Array<{ method: string; body?: string }> = [];
  globalThis.fetch = async (_input, init) => {
    requests.push({ method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : undefined });
    if (!init?.method) return new Response(JSON.stringify([{ data: { dca: { enabled: false, amount: 5, symbols: ["BTCUSDC"] }, events: [] } }]), { status: 200 });
    return new Response(null, { status: 204 });
  };
  assert.equal(await setDcaEnabled("https://example.supabase.co", "key", true), true);
  const patch = JSON.parse(requests[1]?.body ?? "{}");
  assert.deepEqual(patch.data.dca, { enabled: true, amount: 5, symbols: ["BTCUSDC"] });
  assert.equal(patch.data.events[0].message, "Týdenní DCA zapnuto");
});

test("test DCA creates a single isolated Testnet request", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const requests: Array<{ url: string; method: string; body?: string }> = [];
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : undefined });
    if (!init?.method) return new Response(JSON.stringify([{ data: { environment: "testnet", dca: { enabled: true, amount: 5 }, events: [] } }]), { status: 200 });
    return new Response(null, { status: 204 });
  };
  const id = await requestTestDca("https://example.supabase.co", "key", "kry_0123456789abcdef0123456789abcdef");
  assert.match(id, /^test-[a-f0-9]{12}$/);
  assert.ok(requests.every((item) => item.url.includes("key=eq.kry_0123456789abcdef0123456789abcdef")));
  const patch = JSON.parse(requests[1]?.body ?? "{}");
  assert.equal(patch.data.dca.test_request.status, "pending");
  assert.equal(patch.data.events[0].message, "Testovací DCA zařazeno");
});
