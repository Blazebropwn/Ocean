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
  assert.deepEqual(kryptotron.balance, { amount: 73.93, asset: "USDC" });
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
