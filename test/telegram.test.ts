import test from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/app.js";
import { openDatabase } from "../src/db.js";
import { processTelegramMessage } from "../src/telegram.js";

test("Telegram pairing code is hashed, single-use and binds one chat", async () => {
  const db = openDatabase(":memory:");
  const config = {
    port: 0, host: "127.0.0.1", databasePath: ":memory:", appOrigin: "http://localhost", isProduction: false,
    telegramBotToken: "bot-token", telegramBotUsername: "OceanTestBot",
  };
  const app = buildApp(config, db);
  const registration = await app.inject({ method: "POST", url: "/api/auth/register", payload: { email: "ocean@example.com", username: "captain", password: "safe password" } });
  const cookie = registration.headers["set-cookie"]?.toString().split(";")[0];
  const pairing = await app.inject({ method: "POST", url: "/api/telegram/pairing", headers: { cookie: cookie! }, payload: {} });
  assert.equal(pairing.statusCode, 201);
  const code = pairing.json().pairing.code as string;
  assert.match(code, /^[A-F0-9]{8}$/);
  const stored = db.prepare("SELECT token_hash FROM telegram_pairings").get() as { token_hash: string };
  assert.notEqual(stored.token_hash, code);

  const messages: string[] = [];
  await processTelegramMessage(db, config, { chat: { id: 12345 }, from: { username: "diver" }, text: `/start ${code}` }, async (_chat, text) => { messages.push(text); });
  assert.match(messages[0]!, /propojen/);
  assert.deepEqual(db.prepare("SELECT chat_id, telegram_username FROM telegram_connections").get(), { chat_id: "12345", telegram_username: "diver" });
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM telegram_pairings").get() as { count: number }).count, 0);

  const disconnected = await app.inject({ method: "DELETE", url: "/api/telegram", headers: { cookie: cookie! } });
  assert.equal(disconnected.statusCode, 204);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM telegram_connections").get() as { count: number }).count, 0);
  const status = await app.inject({ method: "GET", url: "/api/telegram", headers: { cookie: cookie! } });
  assert.equal(status.json().telegram.connected, false);
  await app.close();
});

test("unlinked Telegram chat cannot control Kryptotron", async () => {
  const db = openDatabase(":memory:");
  const messages: string[] = [];
  await processTelegramMessage(db, { port: 0, host: "127.0.0.1", databasePath: ":memory:", appOrigin: "http://localhost", isProduction: false }, { chat: { id: 999 }, text: "/pause" }, async (_chat, text) => { messages.push(text); });
  assert.match(messages[0]!, /není propojený/);
  db.close();
});
