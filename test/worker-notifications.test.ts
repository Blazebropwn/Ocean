import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { buildApp } from "../src/app.js";
import { openDatabase } from "../src/db.js";
import { workerAccessToken } from "../src/worker-auth.js";
import { deliverWorkerNotifications, processTelegramMessage } from "../src/telegram.js";

function setup() {
  const db = openDatabase(":memory:");
  const key = randomBytes(32);
  const instanceId = "kry_" + "a".repeat(32);
  db.prepare("INSERT INTO users (id,email,username,password_hash) VALUES ('user','user@example.com','user','hash')").run();
  db.prepare("INSERT INTO kryptotron_instances (id,user_id,remote_state_key,status) VALUES (?,'user',?,'connected')").run(instanceId, instanceId);
  db.prepare("INSERT INTO telegram_connections (user_id,chat_id) VALUES ('user','77')").run();
  const config = { port: 0, host: "127.0.0.1", databasePath: ":memory:", appOrigin: "http://localhost", isProduction: false,
    credentialsEncryptionKey: key.toString("base64"), kryptotronSupabaseUrl: "https://example.supabase.co", kryptotronSupabaseKey: "key" };
  return { db, config, instanceId, headers: { authorization: `Bearer ${workerAccessToken(key, instanceId)}`, "x-ocean-instance": instanceId } };
}

test("worker notifications are scoped, durable and deduplicated on retry", async () => {
  const { db, config, instanceId, headers } = setup();
  const app = buildApp(config, db);
  const payload = { id: "b".repeat(32), message: "<b>Ocean</b> test", chat_id: "attacker" };
  const send = () => app.inject({ method: "POST", url: "/internal/kryptotron/notifications", headers, payload });
  assert.equal((await send()).statusCode, 202);
  assert.equal((await send()).statusCode, 202);
  assert.equal(db.prepare("SELECT COUNT(*) FROM worker_notifications").pluck().get(), 1);
  assert.equal((await app.inject({ method: "POST", url: "/internal/kryptotron/notifications", headers: { ...headers, "x-ocean-instance": "kry_" + "c".repeat(32) }, payload })).statusCode, 401);
  const sent: string[] = [];
  await deliverWorkerNotifications(db, async (chat, text) => { sent.push(chat + text); });
  await deliverWorkerNotifications(db, async () => { throw new Error("must not send twice"); });
  assert.deepEqual(sent, ["77<b>Ocean</b> test"]);
  assert.ok(db.prepare("SELECT sent_at FROM worker_notifications WHERE instance_id = ?").pluck().get(instanceId));
  await app.close();
});

test("delivery failures retry later and keep tokens out of the database", async () => {
  const { db, instanceId } = setup();
  db.prepare("INSERT INTO worker_notifications (instance_id,id,message) VALUES (?,'id','message')").run(instanceId);
  await deliverWorkerNotifications(db, async () => { throw new Error("secret-token"); });
  assert.deepEqual(db.prepare("SELECT attempts,last_error,sent_at FROM worker_notifications").get(),
    { attempts: 1, last_error: "TELEGRAM_SEND_FAILED", sent_at: null });
  let calls = 0;
  await deliverWorkerNotifications(db, async () => { calls++; });
  assert.equal(calls, 0);
  db.prepare("UPDATE worker_notifications SET next_attempt_at = datetime('now','-1 second')").run();
  await deliverWorkerNotifications(db, async () => { calls++; });
  assert.equal(calls, 1);
  db.close();
});

test("DCA activation requires a one-use confirmation bound to the linked user", async (t) => {
  const { db, config } = setup();
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; db.close(); });
  let writes = 0;
  globalThis.fetch = async (_input, init) => {
    if (init?.method === "PATCH") { writes++; return new Response(null, { status: 204 }); }
    return new Response(JSON.stringify([{ data: { dca: { enabled: false } } }]));
  };
  const messages: string[] = [];
  const send = async (_chat: string, text: string) => { messages.push(text); };
  await processTelegramMessage(db, config, { chat: { id: 77 }, text: "/dca_on" }, send);
  assert.equal(writes, 0);
  const code = messages[0]!.match(/\/confirm ([A-F0-9]+)/)![1]!;
  await processTelegramMessage(db, config, { chat: { id: 88 }, text: `/confirm ${code}` }, send);
  assert.equal(writes, 0);
  await processTelegramMessage(db, config, { chat: { id: 77 }, text: `/confirm ${code}` }, send);
  assert.equal(writes, 1);
  await processTelegramMessage(db, config, { chat: { id: 77 }, text: `/confirm ${code}` }, send);
  assert.equal(writes, 1);
});
