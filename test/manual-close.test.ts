import test from "node:test";
import assert from "node:assert/strict";
import { manualCloseView, mergeManualClose, queueManualClose } from "../src/manual-close.js";
import { requestManualClose, saveKryptotronState } from "../src/kryptotron.js";
const state = (): Record<string, unknown> => ({
  manual_close_version: 1, api_permissions_safe: true, safe_mode: false, entries_paused: true,
  last_heartbeat_at: new Date().toISOString(), reconciliation: { status: "OK", checked_at: new Date().toISOString() },
  positions: { BTCUSDC: { in_position: true, entry_order_client_id: "entry-1", protection_status: "ACTIVE", position_qty: .001 } },
});

test("manual intent is specific, idempotent, and works while entries are paused", () => {
  const data = state();
  const request = queueManualClose(data, "BTCUSDC", "entry-1");
  assert.equal(queueManualClose(data, "BTCUSDC", "entry-1"), request);
  assert.equal(data.entries_paused, true);
  assert.throws(() => queueManualClose(data, "BTCUSDC", "entry-2"));
  assert.throws(() => queueManualClose(state(), "SOLUSDC", "entry-1"));
  assert.throws(() => queueManualClose(state(), "BTCUSDC", "old-entry"));
});

test("unverified, stale, pending, and old workers cannot accept an exit", () => {
  for (const override of [{ safe_mode: true }, { manual_close_version: undefined }, { api_permissions_safe: false },
    { last_heartbeat_at: "2020-01-01" }, { reconciliation: { status: "OK", checked_at: "2020-01-01" } },
    { pending_order: { side: "BUY" } }, { pending_protection: {} }, { dca: { pending: {} } }]) {
    assert.throws(() => queueManualClose({ ...state(), ...override }, "BTCUSDC", "entry-1"));
  }
});

test("worker writes cannot erase, rewind, forge, or retarget a user command", () => {
  const data = state(), queued = queueManualClose(data, "BTCUSDC", "entry-1");
  assert.deepEqual(mergeManualClose(undefined, queued), queued);
  const selling = { ...queued, status: "selling" };
  assert.deepEqual(mergeManualClose(queued, selling), selling);
  const forged = mergeManualClose({ ...selling, symbol: "ETHUSDC", position_id: "new", requested_at: "x" }, queued)!;
  assert.equal(forged.symbol, "BTCUSDC");
  assert.equal(forged.position_id, "entry-1");
  assert.equal(mergeManualClose(queued, undefined), undefined);
  assert.deepEqual(mergeManualClose(selling, { ...queued, id: "new" }), { ...queued, id: "new" });
});

test("durable queue survives a concurrent stale worker snapshot and deduplicates retries", async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let stored = state();
  const old = structuredClone(stored);
  let writes = 0;
  globalThis.fetch = async (input, init) => {
    assert.match(String(input), /bot_state\?key=eq\.kry_test/);
    if (init?.method === "PATCH") {
      stored = JSON.parse(String(init.body)).data;
      writes++;
      return new Response(null, { status: 204 });
    }
    return new Response(JSON.stringify([{ data: structuredClone(stored) }]), { status: 200 });
  };
  const [one, two] = await Promise.all([requestManualClose("https://example.test", "key", "kry_test", "BTCUSDC", "entry-1"), requestManualClose("https://example.test", "key", "kry_test", "BTCUSDC", "entry-1")]);
  assert.equal(one.id, two.id);
  assert.equal(writes, 1);
  await saveKryptotronState("https://example.test", "key", "kry_test", old);
  assert.equal(manualCloseView(stored).request?.id, one.id);
  assert.equal(manualCloseView(stored).available, false);
});

test("HTTP close requires auth, confirmation and origin; always uses the signed-in user's instance", async t => {
  const { buildApp } = await import("../src/app.js");
  const { openDatabase } = await import("../src/db.js");
  const db = openDatabase(":memory:");
  const app = buildApp({ port: 0, host: "127.0.0.1", databasePath: ":memory:", appOrigin: "http://localhost:3000", isProduction: false, manualApprovalEnabled: true,
    kryptotronSupabaseUrl: "https://example.test", kryptotronSupabaseKey: "key" }, db);
  t.after(() => app.close());
  const registration = await app.inject({ method: "POST", url: "/api/auth/register", payload: { username: "manual_owner", password: "a safe password", confirmation: "a safe password" } });
  const cookie = registration.headers["set-cookie"]!.toString().split(";")[0]!;
  const ownerId = registration.json().user.id;
  const instance = db.prepare("SELECT id FROM kryptotron_instances WHERE user_id = ?").get(ownerId) as { id: string };
  db.prepare("UPDATE kryptotron_instances SET status = 'connected', remote_state_key = id WHERE id = ?").run(instance.id);
  const path = "/api/kryptotron/positions/close";
  const payload = { symbol: "BTCUSDC", positionId: "entry-1", confirmed: true };
  assert.equal((await app.inject({ method: "POST", url: path, payload })).statusCode, 401);
  assert.equal((await app.inject({ method: "POST", url: path, headers: { cookie, origin: "https://evil.test" }, payload })).statusCode, 403);
  assert.equal((await app.inject({ method: "POST", url: path, headers: { cookie }, payload: { ...payload, confirmed: false } })).statusCode, 400);
  assert.equal((await app.inject({ method: "POST", url: path, headers: { cookie }, payload: { ...payload, instanceId: "someone-else" } })).statusCode, 400);
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let stored = state();
  globalThis.fetch = async (input, init) => {
    assert.equal(new URL(String(input)).searchParams.get("key"), `eq.${instance.id}`);
    if (init?.method === "PATCH") {
      stored = JSON.parse(String(init.body)).data;
      return new Response(null, { status: 204 });
    }
    return new Response(JSON.stringify([{ data: stored }]));
  };
  const response = await app.inject({ method: "POST", url: path, headers: { cookie }, payload });
  assert.equal(response.statusCode, 202);
  const retry = await app.inject({ method: "POST", url: path, headers: { cookie }, payload });
  assert.equal(retry.json().request.id, response.json().request.id);
});

test("transparency replaces an expired manual pause with waiting for the scheduled check", async () => {
  const { readKryptotronTransparency } = await import("../src/kryptotron-transparency.js");
  const now = Date.parse("2026-09-29T12:00:00Z");
  const data = { pair_cooldowns: { BTCUSDC: "2026-09-29T13:00:00Z" }, decisions: {
    BTCUSDC: { checkedAt: "2026-09-29T11:00:00Z", reasonCode: "PAIR_COOLDOWN", positionState: "FLAT", decision: "NO_ENTRY" },
  } };
  assert.equal(readKryptotronTransparency(data, now).decisions[0]?.reasonCode, "PAIR_COOLDOWN");
  assert.equal(readKryptotronTransparency(data, now + 3600001).decisions[0]?.reasonCode, "AWAITING_STRATEGY_CHECK");
});

test("an ambiguous completion write cannot resurrect a sold position or erase its cooldown", async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const old = state();
  const command = queueManualClose(old, "BTCUSDC", "entry-1");
  const completed = { ...old, positions: {}, manual_close: { ...command, status: "completed" }, pair_cooldowns: { BTCUSDC: "2026-09-29T13:00:00Z" } };
  let writes = 0;
  globalThis.fetch = async (_input, init) => {
    if (init?.method === "PATCH") writes++;
    return new Response(JSON.stringify([{ data: completed }]));
  };
  await assert.rejects(() => saveKryptotronState("https://example.test", "key", "kry_test", old), /autoritativní/);
  assert.equal(writes, 0);
});
