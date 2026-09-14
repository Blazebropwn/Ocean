import test from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/app.js";
import { openDatabase, type OceanDatabase } from "../src/db.js";
import type { Config } from "../src/config.js";
import { AGENT_001_PERMISSION_POLICY } from "../src/agents/permissions.js";
import type { PortfolioProvider } from "../src/portfolio/provider.js";
import { completePortfolioSnapshotFixture } from "./fixtures/portfolio.js";

function portfolioFor(userId: string) {
  const snapshot = completePortfolioSnapshotFixture();
  snapshot.subject.userId = userId;
  const observedAt = new Date().toISOString();
  snapshot.capturedAt = observedAt;
  for (const asset of snapshot.assets) {
    if (asset.price) asset.price.observedAt = observedAt;
  }
  return snapshot;
}

const config: Config = {
  port: 0,
  host: "127.0.0.1",
  databasePath: ":memory:",
  appOrigin: "http://localhost:3000",
  isProduction: false,
  manualApprovalEnabled: true,
};

async function register(app: ReturnType<typeof buildApp>, username: string, inviteToken?: string) {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { username, password: "a sufficiently safe password", confirmation: "a sufficiently safe password", inviteToken },
  });
  assert.equal(response.statusCode, 201);
  return {
    id: response.json().user.id as string,
    cookie: response.headers["set-cookie"]!.toString().split(";")[0]!,
  };
}

function insertAgentRun(db: OceanDatabase, userId: string, suffix: string) {
  const agentId = `agt_${suffix.repeat(32)}`;
  const runId = `run_${suffix.repeat(32)}`;
  db.prepare(`
    INSERT INTO agents (id, user_id, name, goal, status, permissions_json)
    VALUES (?, ?, 'Portfolio Risk Agent', 'Vyhodnotit koncentraci portfolia.', 'active', ?)
  `).run(agentId, userId, JSON.stringify(AGENT_001_PERMISSION_POLICY));
  db.prepare(`
    INSERT INTO agent_runs (
      id, agent_id, trigger_type, goal, status, validation_status, snapshot_id,
      result_json, action_count, started_at, completed_at, created_at
    ) VALUES (?, ?, 'scheduled', 'Vyhodnotit koncentraci portfolia.', 'succeeded', 'passed', ?, ?, 3, ?, ?, ?)
  `).run(
    runId,
    agentId,
    `psn_${suffix.repeat(32)}`,
    JSON.stringify({ riskLevel: "moderate" }),
    "2026-09-14T08:00:00.000Z",
    "2026-09-14T08:00:01.000Z",
    "2026-09-14T08:00:00.000Z",
  );
  db.prepare(`
    INSERT INTO agent_ledger_entries (
      id, run_id, sequence, action_type, input_json, output_json, result, occurred_at
    ) VALUES (?, ?, 1, 'portfolio_snapshot_loaded', ?, ?, 'success', ?)
  `).run(`led_${suffix.repeat(32)}`, runId, JSON.stringify({ providerId: "fixture" }), JSON.stringify({ snapshotId: `psn_${suffix.repeat(32)}` }), "2026-09-14T08:00:00.100Z");
  return { agentId, runId };
}

test("Agent Card and run history expose only the authenticated user's agent", async () => {
  const db = openDatabase(":memory:");
  const app = buildApp(config, db);
  const owner = await register(app, "agent_owner");
  const invitation = await app.inject({ method: "POST", url: "/api/invitations", headers: { cookie: owner.cookie }, payload: {} });
  const inviteToken = new URL(invitation.json().invitation.inviteUrl).searchParams.get("invite")!;
  const member = await register(app, "agent_member", inviteToken);
  const ownerRecords = insertAgentRun(db, owner.id, "a");
  const memberRecords = insertAgentRun(db, member.id, "b");

  const cardResponse = await app.inject({ method: "GET", url: "/api/agent", headers: { cookie: owner.cookie } });
  assert.equal(cardResponse.statusCode, 200);
  const card = cardResponse.json().agent;
  assert.equal(card.id, ownerRecords.agentId);
  assert.equal(card.mode, "simulation");
  assert.equal(card.lastRun.id, ownerRecords.runId);
  assert.equal(card.lastRun.success, true);
  assert.equal(card.lastRun.ledgerUrl, `/api/agent/runs/${ownerRecords.runId}`);

  const history = await app.inject({ method: "GET", url: "/api/agent/runs", headers: { cookie: owner.cookie } });
  assert.deepEqual(history.json().runs.map((run: { id: string }) => run.id), [ownerRecords.runId]);

  const forbiddenByOwnership = await app.inject({ method: "GET", url: `/api/agent/runs/${memberRecords.runId}`, headers: { cookie: owner.cookie } });
  assert.equal(forbiddenByOwnership.statusCode, 404);
  await app.close();
});

test("run detail contains its validated result and ordered Proof Ledger", async () => {
  const db = openDatabase(":memory:");
  const app = buildApp(config, db);
  const owner = await register(app, "ledger_owner");
  const { runId } = insertAgentRun(db, owner.id, "c");

  const response = await app.inject({ method: "GET", url: `/api/agent/runs/${runId}`, headers: { cookie: owner.cookie } });
  assert.equal(response.statusCode, 200);
  const run = response.json().run;
  assert.equal(run.status, "succeeded");
  assert.equal(run.validationStatus, "passed");
  assert.deepEqual(run.result, { riskLevel: "moderate" });
  assert.deepEqual(run.ledger, [{
    sequence: 1,
    actionType: "portfolio_snapshot_loaded",
    input: { providerId: "fixture" },
    output: { snapshotId: `psn_${"c".repeat(32)}` },
    result: "success",
    costMicrounits: 0,
    occurredAt: "2026-09-14T08:00:00.100Z",
  }]);
  await app.close();
});

test("agent endpoints require authentication and validate run ids", async () => {
  const app = buildApp(config, openDatabase(":memory:"));
  assert.equal((await app.inject({ method: "GET", url: "/api/agent" })).statusCode, 401);
  const owner = await register(app, "validation_owner");
  assert.equal((await app.inject({ method: "GET", url: "/api/agent/runs/not-a-run", headers: { cookie: owner.cookie } })).statusCode, 400);
  assert.equal((await app.inject({ method: "GET", url: "/api/agent", headers: { cookie: owner.cookie } })).statusCode, 404);
  await app.close();
});

test("approved user can provision and complete one simulation-only AGENT-001 run", async () => {
  let providerUserId: string | null = null;
  const provider: PortfolioProvider = {
    id: "route-fixture",
    async getSnapshot(input) {
      providerUserId = input.userId;
      return portfolioFor(input.userId);
    },
  };
  const db = openDatabase(":memory:");
  const app = buildApp(config, db, { portfolioProvider: provider });
  const owner = await register(app, "run_owner");

  const response = await app.inject({
    method: "POST",
    url: "/api/agent/runs",
    headers: { cookie: owner.cookie },
  });
  assert.equal(response.statusCode, 201);
  const run = response.json().run;
  assert.equal(providerUserId, owner.id);
  assert.equal(run.status, "succeeded");
  assert.equal(run.validationStatus, "passed");
  assert.equal(run.actionCount, 4);
  assert.equal(run.humanInterventions, 0);
  assert.equal((run.result as { mode: string }).mode, "simulation");

  const card = await app.inject({ method: "GET", url: "/api/agent", headers: { cookie: owner.cookie } });
  assert.equal(card.statusCode, 200);
  assert.equal(card.json().agent.lastRun.id, run.id);
  assert.equal(card.json().agent.lastRun.success, true);

  const detail = await app.inject({ method: "GET", url: `/api/agent/runs/${run.id}`, headers: { cookie: owner.cookie } });
  assert.deepEqual(detail.json().run.ledger.map((entry: { actionType: string }) => entry.actionType), [
    "portfolio_snapshot_loaded",
    "risk_metrics_calculated",
    "risk_report_generated",
    "risk_report_validated",
  ]);
  assert.equal(db.prepare("SELECT COUNT(*) FROM agents WHERE user_id = ?").pluck().get(owner.id), 1);
  await app.close();
});

test("failed manual run remains auditable and returns its run id", async () => {
  const provider: PortfolioProvider = {
    id: "failed-route-fixture",
    async getSnapshot() { throw new Error("Portfolio není dostupné."); },
  };
  const db = openDatabase(":memory:");
  const app = buildApp(config, db, { portfolioProvider: provider });
  const owner = await register(app, "failed_run_owner");

  const response = await app.inject({ method: "POST", url: "/api/agent/runs", headers: { cookie: owner.cookie } });
  assert.equal(response.statusCode, 422);
  assert.match(response.json().runId, /^run_[a-f0-9]{32}$/);

  const detail = await app.inject({
    method: "GET",
    url: `/api/agent/runs/${response.json().runId}`,
    headers: { cookie: owner.cookie },
  });
  assert.equal(detail.statusCode, 200);
  assert.equal(detail.json().run.status, "failed");
  assert.equal(detail.json().run.ledger[0].result, "failure");
  await app.close();
});

test("manual run refuses unapproved users and concurrent execution", async () => {
  const db = openDatabase(":memory:");
  const app = buildApp(config, db, { portfolioProvider: {
    id: "unused-fixture",
    async getSnapshot(input) { return portfolioFor(input.userId); },
  } });
  const owner = await register(app, "approval_owner");
  const invitation = await app.inject({ method: "POST", url: "/api/invitations", headers: { cookie: owner.cookie }, payload: {} });
  const token = new URL(invitation.json().invitation.inviteUrl).searchParams.get("invite")!;
  const member = await register(app, "unapproved_runner", token);
  assert.equal((await app.inject({ method: "POST", url: "/api/agent/runs", headers: { cookie: member.cookie } })).statusCode, 403);

  const agentId = `agt_${"d".repeat(32)}`;
  db.prepare(`INSERT INTO agents (id, user_id, name, goal, status, permissions_json)
    VALUES (?, ?, 'Risk Agent', 'Risk report.', 'active', ?)`)
    .run(agentId, owner.id, JSON.stringify(AGENT_001_PERMISSION_POLICY));
  db.prepare(`INSERT INTO agent_runs (id, agent_id, trigger_type, goal, status, started_at)
    VALUES (?, ?, 'manual', 'Risk report.', 'running', ?)`)
    .run(`run_${"d".repeat(32)}`, agentId, new Date().toISOString());
  assert.equal((await app.inject({ method: "POST", url: "/api/agent/runs", headers: { cookie: owner.cookie } })).statusCode, 409);
  await app.close();
});
