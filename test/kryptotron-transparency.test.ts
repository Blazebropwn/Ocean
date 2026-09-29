import test from "node:test";
import assert from "node:assert/strict";
import { readKryptotronTransparency } from "../src/kryptotron-transparency.js";
import { loadKryptotronSnapshot, saveKryptotronState, setKryptotronEntriesPaused } from "../src/kryptotron.js";
import { workerStateIssues } from "../src/ops-monitor.js";

test("user explanations use deterministic reasons and reject raw diagnostics", () => {
  const at = "2026-09-26T12:00:00.000Z", now = Date.parse(at);
  const result = readKryptotronTransparency({ safe_mode: true, entries_paused: false,
    reconciliation: { status: "UNRESOLVED", checked_at: at, issues: [{ code: "PROTECTION_ERROR", symbol: "BTCUSDC" }] },
    decisions: { BTCUSDC: { checkedAt: at, reasonCode: "PROTECTION_ERROR", reason: "Traceback: SECRET",
      decision: "REVIEW", marketRegime: "BULL", price: 100, emaFast: 99, emaSlow: 95, risk: {} } },
  }, now);
  assert.equal(result.strategyStatus, "SAFE_MODE");
  assert.match(result.decisions[0]!.reason, /ochrana/);
  assert.doesNotMatch(JSON.stringify(result), /SECRET|Traceback/);
  assert.equal(result.decisions[0]!.reasonCode, "PROTECTION_ERROR");
});

test("missing and old reconciliation never claim a verified account", () => {
  assert.equal(readKryptotronTransparency({ entries_paused: false }).strategyStatus, "UNVERIFIED");
  const result = readKryptotronTransparency({ reconciliation: { status: "OK", checked_at: "2026-09-26T12:00:00Z" } }, Date.parse("2026-09-26T12:02:00Z"));
  assert.equal(result.reconciliation.status, "STALE");
});

test("an old ACTIVE flag alone cannot advertise verified live protection", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async input => new Response(JSON.stringify(String(input).includes("bot_state") ? [{ data: {
    positions: { BTCUSDC: { in_position: true, protection_status: "ACTIVE", trail_active: true } },
    reconciliation: { status: "OK", checked_at: "2020-01-01T00:00:00Z" },
  } }] : []), { status: 200 });
  const snapshot = await loadKryptotronSnapshot("https://example.invalid", "key");
  assert.equal(snapshot.positions[0]!.protectionActive, false);
});

test("a late worker publication cannot overwrite a pause or lose new positions", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let stored: Record<string, unknown> = { entries_paused: false, environment: "testnet", positions: {}, dca: { enabled: false, amount: 5 } };
  globalThis.fetch = async (_url, init) => {
    if (init?.method === "PATCH") {
      stored = JSON.parse(String(init.body)).data;
      return new Response(null, { status: 204 });
    }
    return new Response(JSON.stringify([{ data: structuredClone(stored) }]), { status: 200 });
  };
  const workerState = { ...stored, positions: { BTCUSDC: { in_position: true, position_qty: .001 } } };
  await Promise.all([
    setKryptotronEntriesPaused("https://example.invalid", "key", true, "kry_test"),
    saveKryptotronState("https://example.invalid", "key", "kry_test", workerState),
  ]);
  assert.equal(stored.entries_paused, true);
  assert.deepEqual(stored.positions, workerState.positions);
  const results = await Promise.allSettled([
    saveKryptotronState("https://example.invalid", "key", "kry_test", { ...workerState, safe_mode: true }),
    setKryptotronEntriesPaused("https://example.invalid", "key", false, "kry_test"),
  ]);
  assert.equal(results[1]!.status, "rejected");
  assert.equal(stored.entries_paused, true);
  assert.equal(stored.safe_mode, true);
  assert.deepEqual(stored.positions, workerState.positions);
});

test("ops monitoring catches stale heartbeat, unresolved safety and persistence failures", () => {
  const issues = workerStateIssues({ last_heartbeat_at: "2026-09-26T11:00:00Z", safe_mode: true, pending_trade_logs: [{}] },
    "Kryptotron test", Date.parse("2026-09-26T12:00:00Z"));
  assert.equal(issues.length, 3);
  assert.ok(issues.some(issue => issue.includes("heartbeat")));
  assert.ok(issues.some(issue => issue.includes("bezpečnostní režim")));
  assert.ok(issues.some(issue => issue.includes("historie")));
});
