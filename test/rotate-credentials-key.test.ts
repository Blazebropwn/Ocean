import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { buildApp } from "../src/app.js";
import { openDatabase } from "../src/db.js";
import { credentialsKey, decryptCredential, decryptCredentialWithKeys, encryptCredential } from "../src/credentials.js";
import { rotateCredentialsKey } from "../src/rotate-credentials-key-lib.js";
import type { Config } from "../src/config.js";

const API_KEY = "A".repeat(32);
const API_SECRET = "S".repeat(32);

async function connectedInstance(encryptionKey: string) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    if (String(input).startsWith("https://testnet.binance.vision/api/v3/account?")) {
      return new Response(JSON.stringify({ canTrade: true, balances: [{ asset: "USDC", free: "25", locked: "0" }] }), { status: 200 });
    }
    return new Response(null, { status: 201 });
  };
  const config: Config = {
    port: 0, host: "127.0.0.1", databasePath: ":memory:", appOrigin: "http://localhost:3000", isProduction: false,
    credentialsEncryptionKey: encryptionKey,
    kryptotronSupabaseUrl: "https://example.supabase.co", kryptotronSupabaseKey: "service-key",
  };
  const db = openDatabase(":memory:");
  const app = buildApp(config, db);
  const owner = await app.inject({ method: "POST", url: "/api/auth/register", payload: { username: "owner", password: "owner password" } });
  const cookie = owner.headers["set-cookie"]?.toString().split(";")[0];
  db.prepare("UPDATE users SET email_verified_at = datetime('now') WHERE username = 'owner'").run();
  const connected = await app.inject({
    method: "POST", url: "/api/kryptotron/connection", headers: { cookie: cookie! },
    payload: { apiKey: API_KEY, apiSecret: API_SECRET, environment: "testnet", withdrawalsDisabledConfirmed: true },
  });
  assert.equal(connected.statusCode, 201);
  const instance = db.prepare("SELECT id, user_id FROM kryptotron_instances WHERE user_id = (SELECT id FROM users WHERE username = 'owner')").get() as { id: string; user_id: string };
  globalThis.fetch = originalFetch;
  return { db, instance, closeApp: () => app.close() };
}

test("rotateCredentialsKey re-encrypts stored connections with the new key and leaves them decryptable", async () => {
  const oldKey = randomBytes(32).toString("base64");
  const newKey = randomBytes(32).toString("base64");
  const { db, instance, closeApp } = await connectedInstance(oldKey);
  const context = `${instance.user_id}:${instance.id}`;

  const result = rotateCredentialsKey(db, newKey, oldKey);
  assert.equal(result.total, 1);
  assert.equal(result.alreadyCurrent, 0);
  assert.deepEqual(result.migrated, [instance.id]);
  assert.deepEqual(result.failed, []);

  const row = db.prepare("SELECT api_key_ciphertext, api_key_iv, api_key_tag, api_secret_ciphertext, api_secret_iv, api_secret_tag, key_version FROM kryptotron_credentials WHERE instance_id = ?").get(instance.id) as Record<string, string | number>;
  assert.equal(row.key_version, 2);
  const decryptedApiKey = decryptCredential({ ciphertext: row.api_key_ciphertext as string, iv: row.api_key_iv as string, tag: row.api_key_tag as string }, credentialsKey(newKey), `${context}:api-key`);
  assert.equal(decryptedApiKey, API_KEY);
  assert.throws(() => decryptCredential({ ciphertext: row.api_key_ciphertext as string, iv: row.api_key_iv as string, tag: row.api_key_tag as string }, credentialsKey(oldKey), `${context}:api-key`));
  await closeApp();
});

test("rotateCredentialsKey is idempotent — a second run leaves already-migrated rows alone", async () => {
  const oldKey = randomBytes(32).toString("base64");
  const newKey = randomBytes(32).toString("base64");
  const { db, closeApp } = await connectedInstance(oldKey);

  rotateCredentialsKey(db, newKey, oldKey);
  const second = rotateCredentialsKey(db, newKey, oldKey);
  assert.equal(second.total, 1);
  assert.equal(second.alreadyCurrent, 1);
  assert.deepEqual(second.migrated, []);
  assert.deepEqual(second.failed, []);
  await closeApp();
});

test("rotateCredentialsKey requires a distinct previous key", async () => {
  const key = randomBytes(32).toString("base64");
  const { db, closeApp } = await connectedInstance(key);
  assert.throws(() => rotateCredentialsKey(db, key, undefined), /OCEAN_CREDENTIALS_KEY_PREVIOUS/);
  assert.throws(() => rotateCredentialsKey(db, key, key), /stejný/);
  await closeApp();
});

test("decryptCredentialWithKeys falls back to the previous key during a rotation window", () => {
  const oldKey = credentialsKey(randomBytes(32).toString("base64"));
  const newKey = credentialsKey(randomBytes(32).toString("base64"));
  const encrypted = encryptCredential("still-on-old-key", oldKey, "ctx");
  assert.equal(decryptCredentialWithKeys(encrypted, [newKey, oldKey], "ctx"), "still-on-old-key");
  assert.throws(() => decryptCredentialWithKeys(encrypted, [newKey], "ctx"));
});
