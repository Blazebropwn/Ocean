import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { buildApp } from "../src/app.js";
import { openDatabase } from "../src/db.js";
import { workerAccessToken } from "../src/worker-auth.js";

test("worker broker token can access only its assigned instance", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const keyMaterial = randomBytes(32).toString("base64");
  const key = Buffer.from(keyMaterial, "base64");
  const instanceId = "kry_0123456789abcdef0123456789abcdef";
  globalThis.fetch = async (input) => {
    assert.ok(String(input).includes(`key=eq.${instanceId}`));
    return new Response(JSON.stringify([{ data: { runtime_status: "waiting" } }]), { status: 200 });
  };
  const db = openDatabase(":memory:");
  db.prepare("INSERT INTO users (id, email, username, password_hash, role) VALUES ('usr_worker', 'worker@example.com', 'worker', 'hash', 'member')").run();
  db.prepare("INSERT INTO kryptotron_instances (id, user_id, remote_state_key, status, environment) VALUES (?, 'usr_worker', ?, 'connected', 'testnet')").run(instanceId, instanceId);
  const app = buildApp({
    port: 0, host: "127.0.0.1", databasePath: ":memory:", appOrigin: "http://localhost", isProduction: false,
    credentialsEncryptionKey: keyMaterial, kryptotronSupabaseUrl: "https://example.supabase.co", kryptotronSupabaseKey: "server-secret",
  }, db);
  const valid = await app.inject({ method: "GET", url: "/internal/kryptotron/state", headers: { authorization: `Bearer ${workerAccessToken(key, instanceId)}`, "x-ocean-instance": instanceId } });
  assert.equal(valid.statusCode, 200);
  assert.deepEqual(valid.json(), { state: { runtime_status: "waiting" } });
  const denied = await app.inject({ method: "GET", url: "/internal/kryptotron/state", headers: { authorization: "Bearer wrong", "x-ocean-instance": instanceId } });
  assert.equal(denied.statusCode, 401);
  await app.close();
});
