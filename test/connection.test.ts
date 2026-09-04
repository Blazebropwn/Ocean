import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { buildApp } from "../src/app.js";
import { openDatabase } from "../src/db.js";
import { credentialsKey, decryptCredential, encryptCredential } from "../src/credentials.js";
import type { Config } from "../src/config.js";

test("credentials are authenticated and bound to their Ocean context", () => {
  const key = credentialsKey(randomBytes(32).toString("base64"));
  const encrypted = encryptCredential("secret-value", key, "usr_one:kry_one:api-secret");
  assert.equal(decryptCredential(encrypted, key, "usr_one:kry_one:api-secret"), "secret-value");
  assert.throws(() => decryptCredential(encrypted, key, "usr_two:kry_one:api-secret"));
  assert.ok(!encrypted.ciphertext.includes("secret-value"));
});

test("invited member can verify and securely stage a personal Binance connection", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (input, init) => {
    if (String(input).startsWith("https://testnet.binance.vision/api/v3/account?")) {
      return new Response(JSON.stringify({ canTrade: true, balances: [{ asset: "USDC", free: "25", locked: "0" }] }), { status: 200 });
    }
    assert.equal(String(input), "https://example.supabase.co/rest/v1/bot_state?on_conflict=key");
    assert.equal(init?.method, "POST");
    const provisioned = JSON.parse(String(init?.body)) as { key: string; data: Record<string, unknown> };
    assert.match(provisioned.key, /^kry_[a-f0-9]{32}$/);
    assert.equal(provisioned.data.runtime_status, "provisioning");
    assert.equal(provisioned.data.environment, "testnet");
    assert.equal(provisioned.data.entries_paused, true);
    return new Response(null, { status: 201 });
  };
  const config: Config = {
    port: 0, host: "127.0.0.1", databasePath: ":memory:", appOrigin: "http://localhost:3000", isProduction: false,
    credentialsEncryptionKey: randomBytes(32).toString("base64"),
    kryptotronSupabaseUrl: "https://example.supabase.co", kryptotronSupabaseKey: "service-key",
  };
  const db = openDatabase(":memory:");
  const app = buildApp(config, db);
  const owner = await app.inject({ method: "POST", url: "/api/auth/register", payload: { email: "owner@example.com", username: "owner", password: "owner password" } });
  const ownerCookie = owner.headers["set-cookie"]?.toString().split(";")[0];
  db.prepare("UPDATE users SET email_verified_at = datetime('now') WHERE username = 'owner'").run();
  const legacyDisconnect = await app.inject({ method: "DELETE", url: "/api/kryptotron/connection", headers: { cookie: ownerCookie! } });
  assert.equal(legacyDisconnect.statusCode, 409);
  const invite = await app.inject({ method: "POST", url: "/api/invitations", headers: { cookie: ownerCookie! }, payload: { email: "diver@example.com" } });
  const inviteToken = new URL(invite.json().invitation.inviteUrl).searchParams.get("invite");
  const member = await app.inject({ method: "POST", url: "/api/auth/register", payload: { email: "diver@example.com", username: "diver", password: "member password", inviteToken } });
  const memberCookie = member.headers["set-cookie"]?.toString().split(";")[0];
  db.prepare("UPDATE users SET email_verified_at = datetime('now') WHERE username = 'diver'").run();

  const mainnetBlocked = await app.inject({
    method: "POST", url: "/api/kryptotron/connection", headers: { cookie: memberCookie! },
    payload: { apiKey: "A".repeat(32), apiSecret: "S".repeat(32), environment: "mainnet", withdrawalsDisabledConfirmed: true },
  });
  assert.equal(mainnetBlocked.statusCode, 403);

  const connected = await app.inject({
    method: "POST", url: "/api/kryptotron/connection", headers: { cookie: memberCookie! },
    payload: { apiKey: "A".repeat(32), apiSecret: "S".repeat(32), environment: "testnet", withdrawalsDisabledConfirmed: true },
  });
  assert.equal(connected.statusCode, 201);
  assert.equal(connected.json().connection.status, "provisioning");
  assert.equal(connected.json().verification.withdrawalsDisabled, true);
  assert.ok(!connected.body.includes("A".repeat(32)));
  assert.ok(!connected.body.includes("S".repeat(32)));

  const stored = db.prepare("SELECT * FROM kryptotron_credentials").get() as Record<string, string>;
  assert.ok(stored.api_key_ciphertext);
  assert.ok(!Object.values(stored).includes("A".repeat(32)));
  assert.ok(!Object.values(stored).includes("S".repeat(32)));
  const instance = db.prepare("SELECT id, remote_state_key FROM kryptotron_instances WHERE user_id = (SELECT id FROM users WHERE username = 'diver')").get() as { id: string; remote_state_key: string };
  assert.equal(instance.remote_state_key, instance.id);
  const state = await app.inject({ method: "GET", url: "/api/kryptotron/connection", headers: { cookie: memberCookie! } });
  assert.deepEqual(state.json().connection, { status: "provisioning", environment: "testnet", configured: true, legacy: false });

  const disconnected = await app.inject({ method: "DELETE", url: "/api/kryptotron/connection", headers: { cookie: memberCookie! } });
  assert.equal(disconnected.statusCode, 204);
  assert.equal(db.prepare("SELECT 1 FROM kryptotron_credentials WHERE instance_id = ?").get(instance.id), undefined);
  const reset = db.prepare("SELECT status, environment, remote_state_key FROM kryptotron_instances WHERE id = ?").get(instance.id);
  assert.deepEqual(reset, { status: "unconfigured", environment: "testnet", remote_state_key: null });
  const disconnectedState = await app.inject({ method: "GET", url: "/api/kryptotron/connection", headers: { cookie: memberCookie! } });
  assert.deepEqual(disconnectedState.json().connection, { status: "unconfigured", environment: "testnet", configured: false, legacy: false });
  await app.close();
});
