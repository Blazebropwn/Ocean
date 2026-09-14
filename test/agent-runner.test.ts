import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../src/db.js";
import { AGENT_001_PERMISSION_POLICY } from "../src/agents/permissions.js";
import { AgentRepository } from "../src/agents/repository.js";
import { AgentRunError, PortfolioRiskAgentRunner } from "../src/agents/runner.js";
import type { PortfolioProvider } from "../src/portfolio/provider.js";
import { z } from "zod";
import { completePortfolioSnapshotFixture, portfolioFixtureNow } from "./fixtures/portfolio.js";

const AGENT_ID = `agt_${"a".repeat(32)}`;
const USER_ID = "usr_0123456789abcdef0123456789abcdef";

function setup(options: { status?: "active" | "paused"; maxActions?: number; provider?: PortfolioProvider } = {}) {
  const db = openDatabase(":memory:");
  db.prepare("INSERT INTO users (id, email, username, password_hash) VALUES (?, ?, ?, ?)")
    .run(USER_ID, "agent@example.com", "agent-owner", "hash");
  db.prepare(`
    INSERT INTO agents (
      id, user_id, name, goal, status, permissions_json,
      max_actions_per_run, max_cost_microunits_per_run
    ) VALUES (?, ?, 'Risk Agent', 'Vytvořit risk report.', ?, ?, ?, 0)
  `).run(AGENT_ID, USER_ID, options.status ?? "active", JSON.stringify(AGENT_001_PERMISSION_POLICY), options.maxActions ?? 5);
  const provider = options.provider ?? {
    id: "fixture-provider",
    async getSnapshot() { return completePortfolioSnapshotFixture(); },
  };
  const clock = { now: () => portfolioFixtureNow };
  return { db, runner: new PortfolioRiskAgentRunner(new AgentRepository(db), provider, clock) };
}

test("AGENT-001 completes one autonomous simulation run with four proof entries", async () => {
  const { db, runner } = setup();
  const run = await runner.run(AGENT_ID, "scheduled");

  assert.equal(run.status, "succeeded");
  assert.equal(run.validationStatus, "passed");
  assert.equal(run.actionCount, 4);
  assert.equal(run.costMicrounits, 0);
  assert.equal(run.humanInterventions, 0);
  assert.equal((run.result as { mode: string }).mode, "simulation");

  const ledger = db.prepare(`
    SELECT sequence, action_type, result, cost_microunits
    FROM agent_ledger_entries WHERE run_id = ? ORDER BY sequence
  `).all(run.id);
  assert.deepEqual(ledger, [
    { sequence: 1, action_type: "portfolio_snapshot_loaded", result: "success", cost_microunits: 0 },
    { sequence: 2, action_type: "risk_metrics_calculated", result: "success", cost_microunits: 0 },
    { sequence: 3, action_type: "risk_report_generated", result: "success", cost_microunits: 0 },
    { sequence: 4, action_type: "risk_report_validated", result: "success", cost_microunits: 0 },
  ]);
  db.close();
});

test("failed provider action is auditable and closes the run as failed", async () => {
  const provider: PortfolioProvider = {
    id: "broken-provider",
    async getSnapshot() { throw new Error("upstream unavailable"); },
  };
  const { db, runner } = setup({ provider });

  await assert.rejects(
    runner.run(AGENT_ID, "manual"),
    (error) => error instanceof AgentRunError && error.code === "RUN_FAILED" && error.runId !== null,
  );
  const run = db.prepare(`
    SELECT status, validation_status, action_count, human_interventions, error_code
    FROM agent_runs
  `).get();
  assert.deepEqual(run, {
    status: "failed",
    validation_status: "failed",
    action_count: 1,
    human_interventions: 0,
    error_code: "ACTION_FAILED",
  });
  assert.deepEqual(db.prepare("SELECT sequence, result FROM agent_ledger_entries").get(), { sequence: 1, result: "failure" });
  db.close();
});

test("snapshot validation failures expose a safe public message", async () => {
  const provider: PortfolioProvider = {
    id: "invalid-snapshot-provider",
    async getSnapshot() { return z.never().parse("invalid"); },
  };
  const { db, runner } = setup({ provider });

  await assert.rejects(
    runner.run(AGENT_ID, "manual"),
    (error) => error instanceof AgentRunError
      && error.message === "Data portfolia neprošla bezpečnostní kontrolou.",
  );
  const stored = db.prepare("SELECT error_code, error_message FROM agent_runs").get();
  assert.deepEqual(stored, {
    error_code: "INVALID_PORTFOLIO_SNAPSHOT",
    error_message: "Data portfolia neprošla bezpečnostní kontrolou.",
  });
  db.close();
});

test("permission gate prevents a paused agent before provider access", async () => {
  let providerCalls = 0;
  const provider: PortfolioProvider = {
    id: "spy-provider",
    async getSnapshot() { providerCalls += 1; return completePortfolioSnapshotFixture(); },
  };
  const { db, runner } = setup({ status: "paused", provider });
  await assert.rejects(runner.run(AGENT_ID, "scheduled"), (error) => error instanceof AgentRunError && error.code === "RUN_FAILED");
  assert.equal(providerCalls, 0);
  assert.equal(db.prepare("SELECT status FROM agent_runs").pluck().get(), "failed");
  db.close();
});

test("action budget fails closed before an unapproved fourth action", async () => {
  const { db, runner } = setup({ maxActions: 3 });
  await assert.rejects(runner.run(AGENT_ID, "scheduled"), (error) => error instanceof AgentRunError && error.code === "RUN_FAILED");
  assert.equal(db.prepare("SELECT action_count FROM agent_runs").pluck().get(), 3);
  assert.equal(db.prepare("SELECT COUNT(*) FROM agent_ledger_entries").pluck().get(), 3);
  db.close();
});

test("missing agent does not create an orphan run", async () => {
  const { db, runner } = setup();
  await assert.rejects(runner.run(`agt_${"f".repeat(32)}`, "manual"), (error) => error instanceof AgentRunError && error.code === "AGENT_NOT_FOUND");
  assert.equal(db.prepare("SELECT COUNT(*) FROM agent_runs").pluck().get(), 0);
  db.close();
});
