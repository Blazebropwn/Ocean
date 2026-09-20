import test from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/app.js";
import { openDatabase, type OceanDatabase } from "../src/db.js";
import type { Config } from "../src/config.js";

const config: Config = { port: 0, host: "127.0.0.1", databasePath: ":memory:", appOrigin: "http://localhost:3000", isProduction: false, manualApprovalEnabled: true };

async function registerOwnerAndMember(app: ReturnType<typeof buildApp>) {
  const owner = await app.inject({ method: "POST", url: "/api/auth/register", payload: { username: "fleet_owner", password: "a safe password", confirmation: "a safe password" } });
  const ownerCookie = owner.headers["set-cookie"]!.toString().split(";")[0];
  const invite = await app.inject({ method: "POST", url: "/api/invitations", headers: { cookie: ownerCookie }, payload: {} });
  const inviteToken = new URL(invite.json().invitation.inviteUrl).searchParams.get("invite");
  const member = await app.inject({ method: "POST", url: "/api/auth/register", payload: { username: "member_diver", password: "another safe password", confirmation: "another safe password", inviteToken } });
  const memberCookie = member.headers["set-cookie"]!.toString().split(";")[0];
  return { ownerCookie, memberCookie, memberId: member.json().user.id as string };
}

test("owner member overview reports each member's Kryptotron instance status", async () => {
  const db: OceanDatabase = openDatabase(":memory:");
  const app = buildApp(config, db);
  const { ownerCookie, memberId } = await registerOwnerAndMember(app);

  const initial = await app.inject({ method: "GET", url: "/api/members", headers: { cookie: ownerCookie } });
  assert.equal(initial.statusCode, 200);
  const [pending] = initial.json().members;
  assert.equal(pending.id, memberId);
  assert.equal(pending.instance.status, "unconfigured");
  assert.equal(pending.instance.environment, "testnet");
  assert.equal(pending.instance.configured, false);

  const instanceId = (db.prepare("SELECT id FROM kryptotron_instances WHERE user_id = ?").get(memberId) as { id: string }).id;
  db.prepare("UPDATE kryptotron_instances SET status = 'connected', remote_state_key = id WHERE id = ?").run(instanceId);
  db.prepare(`INSERT INTO kryptotron_credentials
    (instance_id, api_key_ciphertext, api_key_iv, api_key_tag, api_secret_ciphertext, api_secret_iv, api_secret_tag, verified_at)
    VALUES (?, 'c', 'i', 't', 'c', 'i', 't', datetime('now'))`).run(instanceId);

  const connected = await app.inject({ method: "GET", url: "/api/members", headers: { cookie: ownerCookie } });
  const [running] = connected.json().members;
  assert.equal(running.instance.status, "connected");
  assert.equal(running.instance.configured, true);

  await app.close();
});

test("member overview is owner-only", async () => {
  const app = buildApp(config, openDatabase(":memory:"));
  const { memberCookie } = await registerOwnerAndMember(app);
  const forbidden = await app.inject({ method: "GET", url: "/api/members", headers: { cookie: memberCookie } });
  assert.equal(forbidden.statusCode, 403);
  await app.close();
});

test("owner deletes a member only after an exact username confirmation and keeps an audit record", async () => {
  const db = openDatabase(":memory:");
  const app = buildApp(config, db);
  const { ownerCookie, memberId } = await registerOwnerAndMember(app);
  const ownerId = (db.prepare("SELECT id FROM users WHERE role = 'owner'").get() as { id: string }).id;
  const instanceId = connectMemberInstance(db, memberId);
  const agentId = `agt_${"a".repeat(32)}`;
  const runId = `run_${"b".repeat(32)}`;
  const ledgerId = `led_${"c".repeat(32)}`;

  db.prepare("INSERT INTO telegram_connections (user_id, chat_id, telegram_username) VALUES (?, '123456', 'member_diver')").run(memberId);
  db.prepare("INSERT INTO telegram_pairings (token_hash, user_id, expires_at) VALUES ('pairing_hash', ?, datetime('now', '+10 minutes'))").run(memberId);
  db.prepare(`INSERT INTO agents (id, user_id, name, goal, status, permissions_json)
    VALUES (?, ?, 'Risk Agent', 'Create a portfolio risk report', 'active', '["portfolio:read","report:write","ledger:write"]')`).run(agentId, memberId);
  db.prepare(`INSERT INTO agent_runs
    (id, agent_id, trigger_type, goal, status, validation_status, result_json, action_count, started_at, completed_at)
    VALUES (?, ?, 'manual', 'Create a portfolio risk report', 'succeeded', 'passed', '{}', 3, datetime('now'), datetime('now'))`).run(runId, agentId);
  db.prepare(`INSERT INTO agent_ledger_entries
    (id, run_id, sequence, action_type, input_json, output_json, result, occurred_at)
    VALUES (?, ?, 1, 'Portfolio Snapshot Loaded', '{}', '{}', 'success', datetime('now'))`).run(ledgerId, runId);

  const rejected = await app.inject({ method: "DELETE", url: `/api/members/${memberId}`, headers: { cookie: ownerCookie }, payload: { confirmation: "someone_else" } });
  assert.equal(rejected.statusCode, 400);
  assert.equal(db.prepare("SELECT COUNT(*) FROM users WHERE id = ?").pluck().get(memberId), 1);

  const deleted = await app.inject({ method: "DELETE", url: `/api/members/${memberId}`, headers: { cookie: ownerCookie }, payload: { confirmation: "member_diver" } });
  assert.equal(deleted.statusCode, 204);
  for (const [table, column, id] of [
    ["users", "id", memberId],
    ["sessions", "user_id", memberId],
    ["kryptotron_instances", "user_id", memberId],
    ["kryptotron_credentials", "instance_id", instanceId],
    ["telegram_connections", "user_id", memberId],
    ["telegram_pairings", "user_id", memberId],
    ["agents", "id", agentId],
    ["agent_runs", "id", runId],
    ["agent_ledger_entries", "id", ledgerId],
  ] as const) {
    assert.equal(db.prepare(`SELECT COUNT(*) FROM ${table} WHERE ${column} = ?`).pluck().get(id), 0, `${table} was not deleted`);
  }
  assert.deepEqual(db.prepare("SELECT actor_user_id, action, subject_user_id, subject_username FROM admin_audit_log").get(), {
    actor_user_id: ownerId,
    action: "MEMBER_DELETED",
    subject_user_id: memberId,
    subject_username: "member_diver",
  });
  await app.close();
});

test("members cannot delete accounts and the owner cannot be targeted", async () => {
  const db = openDatabase(":memory:");
  const app = buildApp(config, db);
  const { ownerCookie, memberCookie, memberId } = await registerOwnerAndMember(app);
  const owner = db.prepare("SELECT id, username FROM users WHERE role = 'owner'").get() as { id: string; username: string };

  const forbidden = await app.inject({ method: "DELETE", url: `/api/members/${memberId}`, headers: { cookie: memberCookie }, payload: { confirmation: "member_diver" } });
  assert.equal(forbidden.statusCode, 403);
  const protectedOwner = await app.inject({ method: "DELETE", url: `/api/members/${owner.id}`, headers: { cookie: ownerCookie }, payload: { confirmation: owner.username } });
  assert.equal(protectedOwner.statusCode, 404);
  assert.equal(db.prepare("SELECT COUNT(*) FROM users WHERE id = ? AND role = 'owner'").pluck().get(owner.id), 1);
  await app.close();
});

const supabaseConfig: Config = { ...config, kryptotronSupabaseUrl: "https://example.supabase.co", kryptotronSupabaseKey: "key" };

function connectMemberInstance(db: OceanDatabase, memberId: string) {
  const instanceId = (db.prepare("SELECT id FROM kryptotron_instances WHERE user_id = ?").get(memberId) as { id: string }).id;
  db.prepare("UPDATE kryptotron_instances SET status = 'connected', remote_state_key = id WHERE id = ?").run(instanceId);
  db.prepare(`INSERT INTO kryptotron_credentials
    (instance_id, api_key_ciphertext, api_key_iv, api_key_tag, api_secret_ciphertext, api_secret_iv, api_secret_tag, verified_at)
    VALUES (?, 'c', 'i', 't', 'c', 'i', 't', datetime('now'))`).run(instanceId);
  return instanceId;
}

test("owner can drill into a connected member's live Kryptotron detail", async (t) => {
  const db = openDatabase(":memory:");
  const app = buildApp(supabaseConfig, db);
  const { ownerCookie, memberId } = await registerOwnerAndMember(app);
  connectMemberInstance(db, memberId);

  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (input) => {
    const url = String(input);
    const body = url.includes("bot_state")
      ? [{ data: { runtime_status: "running", entries_paused: true, account_balance: 73.93, quote_asset: "USDC", positions: {} }, updated_at: "2026-09-06T08:00:00Z" }]
      : [];
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };

  const response = await app.inject({ method: "GET", url: `/api/members/${memberId}/kryptotron`, headers: { cookie: ownerCookie } });
  assert.equal(response.statusCode, 200);
  const { kryptotron } = response.json();
  assert.equal(kryptotron.status, "running");
  assert.equal(kryptotron.entriesPaused, true);
  assert.equal(kryptotron.position, null);
  assert.deepEqual(kryptotron.balance, { amount: 73.93, asset: "USDC", updatedAt: null, error: null });
  await app.close();
});

test("member detail refuses non-owners and unconnected members", async () => {
  const db = openDatabase(":memory:");
  const app = buildApp(supabaseConfig, db);
  const { ownerCookie, memberCookie, memberId } = await registerOwnerAndMember(app);

  const unconnected = await app.inject({ method: "GET", url: `/api/members/${memberId}/kryptotron`, headers: { cookie: ownerCookie } });
  assert.equal(unconnected.statusCode, 409);

  connectMemberInstance(db, memberId);
  const forbidden = await app.inject({ method: "GET", url: `/api/members/${memberId}/kryptotron`, headers: { cookie: memberCookie } });
  assert.equal(forbidden.statusCode, 403);
  await app.close();
});
