import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../src/db.js";
import { AgentRepository } from "../src/agents/repository.js";
import { PortfolioRiskAgentRunner } from "../src/agents/runner.js";
import { isAgentRunDue, runScheduledAgentCheck } from "../src/agent-scheduler.js";
import type { Config } from "../src/config.js";
import type { PortfolioProvider } from "../src/portfolio/provider.js";
import { completePortfolioSnapshotFixture, portfolioFixtureNow } from "./fixtures/portfolio.js";

const USER_ID = "usr_0123456789abcdef0123456789abcdef";

function setup() {
  const db = openDatabase(":memory:");
  db.prepare(`
    INSERT INTO users (id, email, username, password_hash, email_verified_at, approved_at)
    VALUES (?, 'scheduled@example.com', 'scheduled-user', 'hash', datetime('now'), datetime('now'))
  `).run(USER_ID);
  db.prepare(`
    INSERT INTO kryptotron_instances (id, user_id, remote_state_key, status, environment)
    VALUES ('kry_scheduled', ?, 'usr-scheduled', 'connected', 'testnet')
  `).run(USER_ID);
  const repository = new AgentRepository(db);
  const agent = repository.ensurePortfolioRiskAgent(USER_ID);
  let providerCalls = 0;
  const provider: PortfolioProvider = {
    id: "fixture-provider",
    async getSnapshot() { providerCalls += 1; return completePortfolioSnapshotFixture(); },
  };
  const runner = new PortfolioRiskAgentRunner(repository, provider, { now: () => portfolioFixtureNow });
  const config: Config = {
    port: 3000,
    host: "127.0.0.1",
    databasePath: ":memory:",
    appOrigin: "http://localhost:3000",
    isProduction: false,
    manualApprovalEnabled: true,
    agentSchedulerEnabled: true,
    agentDailyRunTime: "10:15",
    agentDailyRunTimeZone: "Europe/Prague",
  };
  const logger = { info() {}, error() {} };
  return { db, repository, runner, config, logger, agent, providerCalls: () => providerCalls };
}

test("daily schedule respects Prague time and SQLite UTC timestamps", () => {
  const now = new Date("2026-09-15T08:15:00.000Z");
  assert.equal(isAgentRunDue(now, [], "10:15", "Europe/Prague"), true);
  assert.equal(isAgentRunDue(now, ["2026-09-15 08:14:00"], "10:15", "Europe/Prague"), false);
  assert.equal(isAgentRunDue(new Date("2026-09-15T08:14:00.000Z"), [], "10:15", "Europe/Prague"), false);
});

test("scheduler performs at most one autonomous simulation run per local day", async () => {
  const fixture = setup();
  const now = portfolioFixtureNow;
  fixture.config.agentDailyRunTime = "00:00";

  await runScheduledAgentCheck({ ...fixture, now });
  await runScheduledAgentCheck({ ...fixture, now });

  assert.equal(fixture.providerCalls(), 1);
  assert.deepEqual(fixture.db.prepare(`
    SELECT trigger_type, mode, status, validation_status, human_interventions
    FROM agent_runs
  `).get(), {
    trigger_type: "scheduled",
    mode: "simulation",
    status: "succeeded",
    validation_status: "passed",
    human_interventions: 0,
  });
  fixture.db.close();
});

test("scheduler ignores agents without an approved connected account", async () => {
  const fixture = setup();
  fixture.db.prepare("UPDATE kryptotron_instances SET status = 'suspended' WHERE user_id = ?").run(USER_ID);
  fixture.config.agentDailyRunTime = "00:00";
  await runScheduledAgentCheck({ ...fixture, now: portfolioFixtureNow });
  assert.equal(fixture.db.prepare("SELECT COUNT(*) FROM agent_runs").pluck().get(), 0);
  assert.equal(fixture.providerCalls(), 0);
  fixture.db.close();
});
