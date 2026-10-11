import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../src/db.js";
import { evaluateOpsAlert, initialOpsAlertState, opsIssues, stuckInstanceIssues, workerIssues, workerStateIssues } from "../src/ops-monitor.js";
import type { Config } from "../src/config.js";

const CONFIG: Config = { port: 3000, host: "127.0.0.1", databasePath: ":memory:", appOrigin: "http://localhost:3000", isProduction: false };

function setup() {
  const db = openDatabase(":memory:");
  db.prepare(`
    INSERT INTO users (id, email, username, password_hash, email_verified_at, approved_at)
    VALUES ('usr_owner', 'owner@example.com', 'owner', 'hash', datetime('now'), datetime('now'))
  `).run();
  return db;
}

test("stuckInstanceIssues only flags instances in error status past the grace period", () => {
  const db = setup();
  const now = new Date("2026-09-22T12:00:00.000Z");
  db.prepare("INSERT INTO kryptotron_instances (id, user_id, status, environment, updated_at) VALUES ('kry_fresh', 'usr_owner', 'error', 'testnet', ?)")
    .run(new Date(now.getTime() - 5 * 60_000).toISOString());
  assert.deepEqual(stuckInstanceIssues(db, now), []);

  db.prepare("UPDATE kryptotron_instances SET updated_at = ? WHERE id = 'kry_fresh'").run(new Date(now.getTime() - 31 * 60_000).toISOString());
  assert.deepEqual(stuckInstanceIssues(db, now), ["Kryptotron uživatele owner (kry_fresh) je v chybovém stavu déle než 30 minut."]);

  db.prepare("UPDATE kryptotron_instances SET status = 'connected' WHERE id = 'kry_fresh'").run();
  assert.deepEqual(stuckInstanceIssues(db, now), []);
  db.close();
});

test("opsIssues combines readiness problems with stuck instances", () => {
  const db = setup();
  const badConfig: Config = { ...CONFIG, kryptotronSupervisorEnabled: true };
  assert.equal(opsIssues(badConfig, db).length, 1);
  db.close();
});

test("evaluateOpsAlert notifies once immediately, then reminds hourly, then confirms resolution", () => {
  let state = initialOpsAlertState;
  const t0 = 1_000_000;

  const first = evaluateOpsAlert(state, ["problem A"], t0);
  assert.match(first.message ?? "", /problem A/);
  state = first.nextState;

  const soonAfter = evaluateOpsAlert(state, ["problem A"], t0 + 5 * 60_000);
  assert.equal(soonAfter.message, null);
  state = soonAfter.nextState;

  const afterCooldown = evaluateOpsAlert(state, ["problem A"], t0 + 61 * 60_000);
  assert.match(afterCooldown.message ?? "", /problem A/);
  assert.match(afterCooldown.message ?? "", /připomínka, stejný problém/);
  state = afterCooldown.nextState;

  const resolved = evaluateOpsAlert(state, [], t0 + 62 * 60_000);
  assert.match(resolved.message ?? "", /pořádku/);
  state = resolved.nextState;

  const staysQuiet = evaluateOpsAlert(state, [], t0 + 63 * 60_000);
  assert.equal(staysQuiet.message, null);
});

test("evaluateOpsAlert re-alerts immediately when the set of problems changes, even inside the cooldown", () => {
  const state = { activeIssuesKey: "problem A", lastAlertAt: 1_000_000 };
  const changed = evaluateOpsAlert(state, ["problem A", "problem B"], 1_000_100);
  assert.match(changed.message ?? "", /problem B/);
});

test('missing protection alerts name the required owner action without hiding mixed issues', async () => {
  const { workerStateIssues } = await import('../src/ops-monitor.js');
  const state = { last_heartbeat_at: new Date().toISOString(), safe_mode: true, reconciliation: { issues: [{code:'PROTECTION_ERROR'}] } };
  assert.match(workerStateIssues(state,'Client')[0]!, /potvrdit obnovení ochrany/);
  state.reconciliation.issues.push({code:'UNATTRIBUTED_BALANCE'});
  assert.doesNotMatch(workerStateIssues(state,'Client')[0]!, /samotné \/resume/);
});

test('admin worker alerts use the account username and environment from the database', async t => {
  const db = setup(); t.after(() => db.close());
  db.prepare("INSERT INTO users (id,email,username,password_hash) VALUES ('usr_second','second@example.com','second-user','hash')").run();
  for (const [id, user, environment] of [['kry_one','usr_owner','mainnet'],['kry_two','usr_second','testnet']]) {
    db.prepare("INSERT INTO kryptotron_instances (id,user_id,status,environment,remote_state_key) VALUES (?,?,'connected',?,?)").run(id,user,environment,id);
  }
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async input => {
    const key = new URL(String(input)).searchParams.get('key');
    if (key === 'eq.kry_two') throw new Error('PRIVATE_TRANSPORT_DETAIL');
    assert.equal(key,'eq.kry_one');
    return new Response(JSON.stringify([{data:{last_heartbeat_at:new Date().toISOString(),safe_mode:true,
      reconciliation:{issues:[{code:'STATE_SAVE_FAILED',message:'PRIVATE_TRANSPORT_DETAIL'}]}}}]));
  };
  const issues = await workerIssues({...CONFIG,kryptotronSupabaseUrl:'https://example.supabase.co',kryptotronSupabaseKey:'test-key'},db);
  assert.match(issues[0]!,/Účet owner · mainnet/);
  assert.match(issues[0]!,/STATE_SAVE_FAILED.*nepodařilo uložit/);
  assert.match(issues[1]!,/Účet second-user · testnet.*vzdálený stav není dostupný/);
  assert.doesNotMatch(issues.join('\n'),/PRIVATE_TRANSPORT_DETAIL|kry_one|kry_two/);
});

test('recovery identifies the resolved account while preserving another account alert', () => {
  const a = 'Účet Alice · mainnet: STATE_SAVE_FAILED';
  const b = 'Účet Bob · testnet: heartbeat není aktuální.';
  const first = evaluateOpsAlert(initialOpsAlertState,[a,b],1_000_000);
  assert.equal(evaluateOpsAlert(first.nextState,[b,a],1_000_001).message,null,'ordering is not a new incident');
  const partial = evaluateOpsAlert(first.nextState,[b],1_000_002);
  assert.match(partial.message!,/Vyřešená upozornění:\n• Účet Alice/);
  assert.match(partial.message!,/Účet Bob/);
  assert.doesNotMatch(partial.message!,/je opět v pořádku/);
  const cleared = evaluateOpsAlert(partial.nextState,[],1_000_003);
  assert.match(cleared.message!,/je opět v pořádku/);
  assert.match(cleared.message!,/Účet Bob/);
  assert.doesNotMatch(cleared.message!,/Alice/);
  assert.equal(evaluateOpsAlert(cleared.nextState,[],1_000_004).message,null);
});

test('admin reasons retain safe codes and symbols, never raw diagnostics', () => {
  const issues = workerStateIssues({last_heartbeat_at:new Date().toISOString(),safe_mode:true,
    reconciliation:{issues:[{code:'INVENTORY_MISMATCH',symbol:'BTCUSDC',message:'secret diagnostics'},
      {code:'STATE_SAVE_FAILED',symbol:'<invalid>'}]}},'Účet Alice · mainnet');
  assert.match(issues[0]!,/INVENTORY_MISMATCH \(BTCUSDC\)/);
  assert.match(issues[0]!,/STATE_SAVE_FAILED/);
  assert.match(issues[0]!,/Nové nákupy jsou zablokované/);
  assert.doesNotMatch(issues[0]!,/secret diagnostics|<invalid>/);
});
