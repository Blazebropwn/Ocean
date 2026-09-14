import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { readBinancePortfolio } from "../src/binance.js";
import { credentialsKey, encryptCredential } from "../src/credentials.js";
import { openDatabase } from "../src/db.js";
import { BinancePortfolioProvider } from "../src/portfolio/binance-provider.js";

const userId = "usr_0123456789abcdef0123456789abcdef";
const instanceId = "kry_0123456789abcdef0123456789abcdef";
const now = new Date("2026-09-14T12:00:00.000Z");

function connectedDatabase(encryptionKeyValue: string) {
  const db = openDatabase(":memory:");
  db.prepare(`INSERT INTO users (id, email, username, password_hash, role, approved_at)
    VALUES (?, 'agent@example.com', 'agent-owner', 'unused-in-this-test', 'member', datetime('now'))`).run(userId);
  db.prepare(`INSERT INTO kryptotron_instances (id, user_id, remote_state_key, status, environment)
    VALUES (?, ?, ?, 'connected', 'testnet')`).run(instanceId, userId, instanceId);
  const key = credentialsKey(encryptionKeyValue);
  const context = `${userId}:${instanceId}`;
  const apiKey = encryptCredential("test-api-key", key, `${context}:api-key`);
  const apiSecret = encryptCredential("test-api-secret", key, `${context}:api-secret`);
  db.prepare(`INSERT INTO kryptotron_credentials (
    instance_id, api_key_ciphertext, api_key_iv, api_key_tag,
    api_secret_ciphertext, api_secret_iv, api_secret_tag, verified_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`).run(
    instanceId,
    apiKey.ciphertext,
    apiKey.iv,
    apiKey.tag,
    apiSecret.ciphertext,
    apiSecret.iv,
    apiSecret.tag,
  );
  return db;
}

test("Binance provider decrypts credentials internally and emits only a normalized snapshot", async () => {
  const keyValue = randomBytes(32).toString("base64");
  const db = connectedDatabase(keyValue);
  const provider = new BinancePortfolioProvider(
    db,
    keyValue,
    async (apiKey, apiSecret, environment) => {
      assert.equal(apiKey, "test-api-key");
      assert.equal(apiSecret, "test-api-secret");
      assert.equal(environment, "testnet");
      return {
        observedAt: "2026-09-14T11:59:00.000Z",
        assets: [
          { asset: "USDC", quantity: 100, priceUsdc: 1 },
          { asset: "BTC", quantity: 0.001, priceUsdc: 60_000 },
        ],
      };
    },
    () => now,
    () => "psn_abcdefabcdefabcdefabcdefabcdefab",
  );

  const snapshot = await provider.getSnapshot({ userId, quoteCurrency: "USDC" });
  assert.equal(snapshot.status, "complete");
  assert.equal(snapshot.provider.readOnly, true);
  assert.deepEqual(snapshot.assets[1]?.value, { amount: 60, quotedIn: "USDC" });
  assert.equal(JSON.stringify(snapshot).includes("test-api"), false);
  db.close();
});

test("Binance provider marks an unpriceable nonzero asset as partial", async () => {
  const keyValue = randomBytes(32).toString("base64");
  const db = connectedDatabase(keyValue);
  const provider = new BinancePortfolioProvider(
    db,
    keyValue,
    async () => ({
      observedAt: "2026-09-14T11:59:00.000Z",
      assets: [{ asset: "UNKNOWN", quantity: 3, priceUsdc: null }],
    }),
    () => now,
  );
  const snapshot = await provider.getSnapshot({ userId, quoteCurrency: "USDC" });
  assert.equal(snapshot.status, "partial");
  assert.equal(snapshot.assets[0]?.value, null);
  db.close();
});

test("Binance provider refuses users without a connected account", async () => {
  const db = openDatabase(":memory:");
  const provider = new BinancePortfolioProvider(db, randomBytes(32).toString("base64"));
  await assert.rejects(
    provider.getSnapshot({ userId, quoteCurrency: "USDC" }),
    /nemá připojený Binance účet/,
  );
  db.close();
});

test("Binance portfolio reader performs GET-only account and market-data requests", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const requests: string[] = [];
  globalThis.fetch = async (input, init) => {
    assert.equal(init?.method, undefined);
    const url = String(input);
    requests.push(url);
    if (url.includes("/api/v3/account?")) {
      assert.equal(new Headers(init?.headers).get("X-MBX-APIKEY"), "read-key");
      return new Response(JSON.stringify({ balances: [
        { asset: "USDC", free: "25", locked: "5" },
        { asset: "BTC", free: "0.002", locked: "0.001" },
        { asset: "DUST", free: "4", locked: "0" },
      ] }), { status: 200 });
    }
    assert.equal(url, "https://testnet.binance.vision/api/v3/ticker/price");
    return new Response(JSON.stringify([{ symbol: "BTCUSDC", price: "50000" }]), { status: 200 });
  };

  const result = await readBinancePortfolio("read-key", "read-secret", "testnet");
  assert.equal(requests.length, 2);
  assert.equal(requests.some((url) => url.includes("order")), false);
  assert.deepEqual(result.assets.map(({ asset, quantity, priceUsdc }) => ({ asset, quantity, priceUsdc })), [
    { asset: "USDC", quantity: 30, priceUsdc: 1 },
    { asset: "BTC", quantity: 0.003, priceUsdc: 50_000 },
    { asset: "DUST", quantity: 4, priceUsdc: null },
  ]);
});
