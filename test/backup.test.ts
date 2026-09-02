import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { createDatabaseBackup } from "../src/backup-lib.js";
import { openDatabase } from "../src/db.js";

test("backup can be opened and contains the original Ocean data", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ocean-backup-"));
  try {
    const source = join(directory, "ocean.db");
    const db = openDatabase(source);
    db.prepare("INSERT INTO users (id, email, username, password_hash, role) VALUES (?, ?, ?, ?, 'owner')")
      .run("usr_backup", "backup@example.com", "backup", "hash");
    db.close();

    const destination = await createDatabaseBackup(source, join(directory, "backups"));
    assert.equal((await stat(destination)).mode & 0o777, 0o600);
    const restored = new Database(destination, { readonly: true });
    assert.deepEqual(restored.pragma("quick_check"), [{ quick_check: "ok" }]);
    assert.equal((restored.prepare("SELECT username FROM users WHERE id = ?").get("usr_backup") as { username: string }).username, "backup");
    restored.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
