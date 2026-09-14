import test from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/app.js";
import { openDatabase, type OceanDatabase } from "../src/db.js";
import type { Config } from "../src/config.js";
import { AGENT_001_PERMISSION_POLICY } from "../src/agents/permissions.js";

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
