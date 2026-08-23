import test from "node:test";
import assert from "node:assert/strict";
import { loadKryptotronSnapshot, setKryptotronEntriesPaused } from "../src/kryptotron.js";

test("maps Kryptotron state and latest trade into the Ocean contract", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (input) => {
    const url = String(input);
    const body = url.includes("bot_state") ? [{
      data: { runtime_status: "waiting", entries_paused: true, last_heartbeat_at: new Date().toISOString(), last_market_check_at: "2026-08-22T08:00:00Z", next_check_at: "2026-08-22T12:00:00Z", account_balance: 73.93, quote_asset: "USDC", events: [{ type: "MARKET", message: "Trh zkontrolován", at: "2026-08-22T08:00:00Z" }], positions: { BTCUSDC: { in_position: true, entry_price: 68000, position_qty: 0.001, highest_price: 70000, protection_status: "ACTIVE", protection_stop_price: 61200, protection_activation_price: 70040, protection_trailing_bips: 150 } }, daily_loss: 1, weekly_loss: 2, trades_today: 1, trades_week: 3 },
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
  assert.equal(snapshot.positions[0]?.protectionActive, true);
  assert.equal(snapshot.positions[0]?.protectionStatus, "ACTIVE");
  assert.equal(snapshot.positions[0]?.protectionPrice, 61200);
  assert.equal(snapshot.positions[0]?.protectionActivationPrice, 70040);
  assert.equal(snapshot.positions[0]?.protectionTrailingBips, 150);
  assert.equal(snapshot.limits.tradesWeek, 3);
  assert.equal(snapshot.lastTrade?.reason, "TRAIL_SL");
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
