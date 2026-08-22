import test from "node:test";
import assert from "node:assert/strict";
import { loadKryptotronSnapshot } from "../src/kryptotron.js";

test("maps Kryptotron state and latest trade into the Ocean contract", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (input) => {
    const url = String(input);
    const body = url.includes("bot_state") ? [{
      data: { runtime_status: "waiting", last_heartbeat_at: new Date().toISOString(), last_market_check_at: "2026-08-22T08:00:00Z", next_check_at: "2026-08-22T12:00:00Z", account_balance: 73.93, quote_asset: "USDC", positions: { BTCUSDC: { in_position: true, entry_price: 68000, position_qty: 0.001, highest_price: 70000, protection_status: "ACTIVE", protection_stop_price: 61200, protection_activation_price: 70040, protection_trailing_bips: 150 } }, daily_loss: 1, weekly_loss: 2, trades_today: 1, trades_week: 3 },
      updated_at: "2026-08-22T08:00:00Z",
    }] : [{ symbol: "BTCUSDC", entry_price: 65000, exit_price: 67000, qty: 0.001, pnl: 2, result: "WIN", reason: "TRAIL_SL", entry_time: "2026-08-20T08:00:00Z", exit_time: "2026-08-21T08:00:00Z" }];
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };

  const snapshot = await loadKryptotronSnapshot("https://example.supabase.co", "key");
  assert.equal(snapshot.connected, true);
  assert.equal(snapshot.status, "waiting");
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
