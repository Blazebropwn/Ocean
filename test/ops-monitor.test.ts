import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../src/db.js";
import { evaluateOpsAlert, initialOpsAlertState, opsIssues, stuckInstanceIssues } from "../src/ops-monitor.js";
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
