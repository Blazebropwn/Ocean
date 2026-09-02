import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../src/db.js";
import { deliverMailBatch } from "../src/mailer.js";

test("mail outbox marks a successfully delivered message", async () => {
  const db = openDatabase(":memory:");
  db.prepare("INSERT INTO mail_outbox (recipient, subject, body) VALUES (?, ?, ?)").run("member@example.com", "Ocean", "Ahoj");
  const sent: unknown[] = [];
  const fetcher = (async (_url: string, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)));
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const count = await deliverMailBatch(db, {
    port: 0, host: "127.0.0.1", databasePath: ":memory:", appOrigin: "http://localhost", isProduction: false,
    resendApiKey: "test", emailFrom: "Ocean <ocean@example.com>",
  }, fetcher);
  assert.equal(count, 1);
  assert.equal(sent.length, 1);
  assert.ok((db.prepare("SELECT sent_at FROM mail_outbox").get() as { sent_at: string }).sent_at);
  db.close();
});
