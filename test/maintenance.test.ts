import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../src/db.js";
import { purgeExpiredRecords } from "../src/maintenance.js";

test("maintenance sweep deletes expired sessions and tokens but keeps valid ones", () => {
  const db = openDatabase(":memory:");
  db.prepare("INSERT INTO users (id, email, username, password_hash, role) VALUES (?, ?, ?, ?, 'owner')")
    .run("usr_sweep", "sweeper@users.ocean.invalid", "sweeper", "hash");
  const past = "2000-01-01T00:00:00.000Z";
  const future = "2999-01-01T00:00:00.000Z";
  db.prepare("INSERT INTO sessions (id_hash, user_id, expires_at) VALUES ('s_old', 'usr_sweep', ?)").run(past);
  db.prepare("INSERT INTO sessions (id_hash, user_id, expires_at) VALUES ('s_new', 'usr_sweep', ?)").run(future);
  db.prepare("INSERT INTO email_verification_tokens (token_hash, user_id, expires_at) VALUES ('e_old', 'usr_sweep', ?)").run(past);
  db.prepare("INSERT INTO password_reset_tokens (token_hash, user_id, expires_at) VALUES ('p_old', 'usr_sweep', ?)").run(past);
  db.prepare("INSERT INTO telegram_pairings (token_hash, user_id, expires_at) VALUES ('t_old', 'usr_sweep', ?)").run(past);

  const removed = purgeExpiredRecords(db);

  assert.deepEqual(removed, { sessions: 1, emailVerifications: 1, passwordResets: 1, telegramPairings: 1 });
  const survivors = db.prepare("SELECT id_hash FROM sessions").all() as Array<{ id_hash: string }>;
  assert.deepEqual(survivors, [{ id_hash: "s_new" }]);

  const secondPass = purgeExpiredRecords(db);
  assert.deepEqual(secondPass, { sessions: 0, emailVerifications: 0, passwordResets: 0, telegramPairings: 0 });
  db.close();
});
