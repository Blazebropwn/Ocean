import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase, type OceanDatabase } from "../src/db.js";

const USER_ID = "usr_agent_schema";
const AGENT_ID = `agt_${"a".repeat(32)}`;
const RUN_ID = `run_${"b".repeat(32)}`;
const LEDGER_ID = `led_${"c".repeat(32)}`;

function databaseWithAgent() {
  const db = openDatabase(":memory:");
  db.prepare("INSERT INTO users (id, email, username, password_hash) VALUES (?, ?, ?, ?)")
    .run(USER_ID, "agent@example.com", "agent-owner", "hash");
  db.prepare(`
    INSERT INTO agents (
      id, user_id, name, goal, status, permissions_json,
      max_actions_per_run, max_cost_microunits_per_run
    ) VALUES (?, ?, ?, ?, 'active', ?, 5, 0)
  `).run(
    AGENT_ID,
    USER_ID,
    "Portfolio Risk Agent",
    "Načíst portfolio, spočítat koncentraci rizika a vytvořit risk report.",
    JSON.stringify({ portfolio: ["read"], report: ["simulate", "write"] }),
  );
  return db;
}

function insertRun(db: OceanDatabase, overrides: Record<string, unknown> = {}) {
  const values = {
    id: RUN_ID,
    agent_id: AGENT_ID,
    trigger_type: "manual",
    mode: "simulation",
    goal: "Vytvořit risk report.",
    status: "running",
    validation_status: "pending",
    result_json: null,
    error_code: null,
    action_count: 0,
    cost_microunits: 0,
    human_interventions: 0,
    started_at: "2026-09-14T08:00:00.000Z",
    completed_at: null,
    ...overrides,
  };
  db.prepare(`
    INSERT INTO agent_runs (
      id, agent_id, trigger_type, mode, goal, status, validation_status,
      result_json, error_code, action_count, cost_microunits,
      human_interventions, started_at, completed_at
    ) VALUES (
      @id, @agent_id, @trigger_type, @mode, @goal, @status, @validation_status,
      @result_json, @error_code, @action_count, @cost_microunits,
      @human_interventions, @started_at, @completed_at
    )
  `).run(values);
}

test("AGENT-001 schema stores a simulation run and an ordered proof ledger", () => {
  const db = databaseWithAgent();
  insertRun(db);
  const insertLedger = db.prepare(`
    INSERT INTO agent_ledger_entries (
      id, run_id, sequence, action_type, input_json, output_json,
      result, cost_microunits, occurred_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'success', 0, ?)
  `);
  insertLedger.run(LEDGER_ID, RUN_ID, 1, "portfolio_loaded", JSON.stringify({ source: "binance", snapshotId: "psn_example" }), JSON.stringify({ assetCount: 3 }), "2026-09-14T08:00:01.000Z");
  insertLedger.run(`led_${"d".repeat(32)}`, RUN_ID, 2, "risk_calculated", JSON.stringify({ snapshotId: "psn_example" }), JSON.stringify({ concentrationPct: 72.4 }), "2026-09-14T08:00:01.500Z");
  insertLedger.run(`led_${"e".repeat(32)}`, RUN_ID, 3, "report_validated", JSON.stringify({ metricCount: 1 }), JSON.stringify({ valid: true }), "2026-09-14T08:00:01.800Z");
  db.prepare(`
    UPDATE agent_runs
    SET status = 'succeeded', validation_status = 'passed', result_json = ?,
        action_count = 3, completed_at = '2026-09-14T08:00:02.000Z'
    WHERE id = ?
  `).run(JSON.stringify({ concentrationPct: 72.4 }), RUN_ID);

  assert.deepEqual(db.prepare(`
    SELECT status, validation_status, action_count, cost_microunits, human_interventions
    FROM agent_runs WHERE id = ?
  `).get(RUN_ID), {
    status: "succeeded",
    validation_status: "passed",
    action_count: 3,
    cost_microunits: 0,
    human_interventions: 0,
  });
  assert.equal(db.prepare("SELECT COUNT(*) FROM agent_ledger_entries WHERE run_id = ?").pluck().get(RUN_ID), 3);
  db.close();
});

test("AGENT-001 database boundary rejects live mode and malformed permissions", () => {
  const db = databaseWithAgent();
  assert.throws(() => insertRun(db, { id: `run_${"d".repeat(32)}`, mode: "live" }), /CHECK constraint failed/);
  assert.throws(() => db.prepare(`
    INSERT INTO agents (id, user_id, name, goal, permissions_json)
    VALUES (?, ?, 'Invalid', 'Invalid policy', 'not-json')
  `).run(`agt_${"e".repeat(32)}`, USER_ID), /CHECK constraint failed/);
  db.close();
});

test("AGENT-001 database boundary enforces run and ledger limits", () => {
  const db = databaseWithAgent();
  assert.throws(() => insertRun(db, { action_count: 6 }), /CHECK constraint failed/);
  assert.throws(() => insertRun(db, { id: `run_${"d".repeat(32)}`, cost_microunits: -1 }), /CHECK constraint failed/);
  assert.throws(() => insertRun(db, { id: `run_${"e".repeat(32)}`, human_interventions: -1 }), /CHECK constraint failed/);

  insertRun(db);
  const insertLedger = db.prepare(`
    INSERT INTO agent_ledger_entries (
      id, run_id, sequence, action_type, input_json, output_json,
      result, cost_microunits, occurred_at
    ) VALUES (?, ?, ?, 'risk_calculated', '{}', '{}', 'success', 0, ?)
  `);
  insertLedger.run(LEDGER_ID, RUN_ID, 1, "2026-09-14T08:00:01.000Z");
  assert.throws(
    () => insertLedger.run(`led_${"d".repeat(32)}`, RUN_ID, 1, "2026-09-14T08:00:02.000Z"),
    /UNIQUE constraint failed/,
  );
  assert.throws(
    () => insertLedger.run(`led_${"e".repeat(32)}`, RUN_ID, 6, "2026-09-14T08:00:03.000Z"),
    /CHECK constraint failed/,
  );
  db.close();
});

test("removing an Ocean user cascades through the complete AGENT-001 record", () => {
  const db = databaseWithAgent();
  insertRun(db);
  db.prepare(`
    INSERT INTO agent_ledger_entries (
      id, run_id, sequence, action_type, input_json, output_json,
      result, cost_microunits, occurred_at
    ) VALUES (?, ?, 1, 'run_started', '{}', '{}', 'success', 0, ?)
  `).run(LEDGER_ID, RUN_ID, "2026-09-14T08:00:00.000Z");

  db.prepare("DELETE FROM users WHERE id = ?").run(USER_ID);
  assert.equal(db.prepare("SELECT COUNT(*) FROM agents").pluck().get(), 0);
  assert.equal(db.prepare("SELECT COUNT(*) FROM agent_runs").pluck().get(), 0);
  assert.equal(db.prepare("SELECT COUNT(*) FROM agent_ledger_entries").pluck().get(), 0);
  db.close();
});
