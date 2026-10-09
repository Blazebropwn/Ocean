import test from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/app.js";
import { openDatabase } from "../src/db.js";
import { hashToken } from "../src/security.js";
import { workerAccessToken } from "../src/worker-auth.js";
import { completeAccountReset, requestAccountReset } from "../src/account-reset-service.js";
import { saveKryptotronState, setKryptotronEntriesPaused, loadKryptotronSnapshot } from "../src/kryptotron.js";

const instance = "kry_" + "3".repeat(32), owner = "usr_" + "1".repeat(32), member = "usr_" + "2".repeat(32);
const resetId = "00000000-0000-4000-8000-000000000001";
const url = "https://reset.example", key = Buffer.alloc(32, 1);
const initial = () => ({ environment: "testnet", entries_paused: true, safe_mode: true,
  last_heartbeat_at: new Date().toISOString(), daily_loss: 3, weekly_loss: 4, trades_today: 2,
  positions: {}, strategy_residuals: { BTCUSDC: { quantity: "0.000078" } },
  dca: { enabled: true, amount: 10, purchases: [{ symbol: "BTCUSDC", quantity: .001, amount: 30 }] }, streak: { enabled: true },
});
function mock(t: any) {
  let state: Record<string, any> = initial(), fail = false, loseResponse = false;
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (input, init) => {
    if (String(input).includes("bot_trades")) return Response.json([{ symbol: "BTCUSDC", exit_time: "2020-01-01T00:00:00Z" }]);
    if (init?.method === "PATCH") {
      if (fail) return new Response(null, { status: 503 });
      state = JSON.parse(String(init.body)).data;
      if (loseResponse) throw new Error("Lost response");
      return (init.headers as Record<string, string>).Prefer === "return=representation" ? Response.json([{ data: state }]) : new Response(null, { status: 204 });
    }
    return Response.json([{ data: structuredClone(state) }]);
  };
  return { get state() { return state; }, set state(value) { state = value; }, set fail(value: boolean) { fail = value; }, set loseResponse(value: boolean) { loseResponse = value; } };
}
const report = () => ({ id: resetId, epoch: null, checkedAt: new Date().toISOString(), balances: { USDC: "100", BTC: "0.000008" } });

test("reset archives before replacement, preserves risk and rejects stale workers and duplicate completion", async t => {
  const remote = mock(t), db = openDatabase(":memory:"); t.after(() => db.close());
  const old = structuredClone(remote.state);
  await requestAccountReset(url, "key", instance, owner, resetId, null);
  assert.equal(remote.state.entries_paused, true); assert.equal(remote.state.dca.enabled, false);
  assert.equal(remote.state.streak.enabled, false);
  await assert.rejects(setKryptotronEntriesPaused(url, "key", false, instance), /nastavení/);
  // An older worker publication cannot remove the queued command or re-enable purchases.
  await saveKryptotronState(url, "key", instance, old);
  assert.equal(remote.state.account_reset.id, resetId); assert.equal(remote.state.dca.enabled, false);
  const next = await completeAccountReset(db, url, "key", instance, report());
  assert.equal(next.state_epoch, resetId); assert.equal(next.entries_paused, true); assert.equal(next.safe_mode, true);
  assert.equal(next.weekly_loss, 4); assert.equal(next.daily_loss, 3); assert.equal(next.trades_today, 2);
  assert.deepEqual(next.unmanaged_inventory, { BTC: "0.000008" });
  assert.deepEqual(next.portfolio_snapshot, {});
  assert.deepEqual((next.dca as any).purchases, []); assert.deepEqual(next.strategy_residuals, {});
  const archive = db.prepare("SELECT state_json FROM account_reset_archives").get() as { state_json: string };
  assert.equal(JSON.parse(archive.state_json).strategy_residuals.BTCUSDC.quantity, "0.000078");
  await assert.rejects(saveKryptotronState(url, "key", instance, old), /Období/);
  assert.deepEqual(await completeAccountReset(db, url, "key", instance, report()), next);
  assert.equal((db.prepare("SELECT count(*) AS n FROM account_reset_archives").get() as any).n, 1);
  assert.equal((await loadKryptotronSnapshot(url, "key", instance)).lastTrade, null);
});

test("lost response and failed writes preserve archives and allow idempotent recovery", async t => {
  const remote = mock(t), db = openDatabase(":memory:"); t.after(() => db.close());
  await requestAccountReset(url, "key", instance, owner, resetId, null);
  remote.fail = true;
  await assert.rejects(completeAccountReset(db, url, "key", instance, report()));
  assert.equal(remote.state.account_reset.status, "queued");
  assert.equal((db.prepare("SELECT count(*) AS n FROM account_reset_archives").get() as any).n, 1);
  remote.fail = false; remote.loseResponse = true;
  await assert.rejects(completeAccountReset(db, url, "key", instance, report()));
  assert.equal(remote.state.state_epoch, resetId);
  remote.loseResponse = false;
  assert.equal((await completeAccountReset(db, url, "key", instance, report())).state_epoch, resetId);
});

test("pending trades, stale heartbeat, changed epoch and expired requests cannot reset", async t => {
  const remote = mock(t), db = openDatabase(":memory:"); t.after(() => db.close());
  for (const patch of [{ pending_order: {} }, { pending_trade_logs: [{}] }, { positions: { BTCUSDC: { in_position: true } } },
    { dca: { pending: {} } }, { manual_close: { status: "selling" } }, { protection_restore: { status: "queued" } },
    { last_heartbeat_at: "2020-01-01" }, { state_epoch: "other" }]) {
    remote.state = { ...initial(), ...patch };
    await assert.rejects(requestAccountReset(url, "key", instance, owner, resetId, null));
  }
  remote.state = initial();
  await requestAccountReset(url, "key", instance, owner, resetId, null);
  remote.state.pending_order = { id: "in-flight" };
  await completeAccountReset(db, url, "key", instance, report());
  assert.equal(remote.state.account_reset.error_code, "UNSETTLED");
  assert.equal(remote.state.state_epoch, undefined);
  remote.state = initial();
  await requestAccountReset(url, "key", instance, owner, resetId, null);
  remote.state.account_reset.requested_at = "2020-01-01T00:00:00Z";
  await completeAccountReset(db, url, "key", instance, report());
  assert.equal(remote.state.account_reset.error_code, "EXPIRED");
  assert.equal((db.prepare("SELECT count(*) AS n FROM account_reset_archives").get() as any).n, 0);
});

test("administrator reset requires approval, origin, exact identity and scoped worker completion", async t => {
  const remote = mock(t), db = openDatabase(":memory:");
  for (const [id, role, name] of [[owner, "owner", "owner"], [member, "member", "member"]]) {
    db.prepare("INSERT INTO users(id,email,username,password_hash,role,approved_at,email_verified_at) VALUES (?,?,?,'hash',?,datetime('now'),datetime('now'))").run(id, name + "@example.com", name, role);
    db.prepare("INSERT INTO sessions(id_hash,user_id,expires_at) VALUES (?,?,datetime('now','+1 day'))").run(hashToken(name!), id);
  }
  db.prepare("INSERT INTO kryptotron_instances(id,user_id,remote_state_key,status,environment) VALUES (?,?,?,'connected','testnet')").run(instance, member, instance);
  const app = buildApp({ port: 0, host: "127.0.0.1", databasePath: ":memory:", appOrigin: "http://localhost", isProduction: false,
    manualApprovalEnabled: true, kryptotronSupabaseUrl: url, kryptotronSupabaseKey: "key", credentialsEncryptionKey: key.toString("base64") }, db);
  t.after(() => app.close());
  const path = `/api/members/${member}/account-reset`, headers = { cookie: "zero_session=owner", origin: "http://localhost" };
  const payload = { confirmation: "member", requestId: resetId, instanceId: instance, epoch: null };
  for (const h of [{}, { cookie: "zero_session=member", origin: "http://localhost" }, { cookie: "zero_session=owner" }]) {
    assert.equal((await app.inject({ method: "POST", url: path, headers: h, payload })).statusCode, 403);
  }
  assert.equal((await app.inject({ method: "POST", url: path, headers, payload: { ...payload, confirmation: "wrong" } })).statusCode, 400);
  assert.equal((await app.inject({ method: "POST", url: path, headers, payload })).statusCode, 202);
  assert.equal((await app.inject({ method: "POST", url: "/internal/kryptotron/account-reset", payload: report() })).statusCode, 401);
  const workerHeaders = { "x-ocean-instance": instance, authorization: "Bearer " + workerAccessToken(key, instance) };
  assert.equal((await app.inject({ method: "POST", url: "/internal/kryptotron/account-reset", headers: workerHeaders, payload: report() })).statusCode, 200);
  const archivePath = path + "/archives/" + resetId;
  assert.equal((await app.inject({ url: archivePath, headers: { cookie: "zero_session=member" } })).statusCode, 403);
  assert.equal((await app.inject({ url: archivePath, headers })).statusCode, 200);
  assert.equal((await app.inject({ url: path, headers })).json().archives.length, 1);
  assert.equal(remote.state.entries_paused, true);
});
