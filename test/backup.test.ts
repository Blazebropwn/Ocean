import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { createDatabaseBackup } from "../src/backup-lib.js";
import { openDatabase } from "../src/db.js";
import { restoreDatabaseBackup } from "../src/restore-lib.js";

test("backup can be restored into a new database with the original Ocean data", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ocean-backup-"));
  try {
    const source = join(directory, "ocean.db");
    const db = openDatabase(source);
    db.prepare("INSERT INTO users (id, email, username, password_hash, role) VALUES (?, ?, ?, ?, 'owner')")
      .run("usr_backup", "backup@example.com", "backup", "hash");
    db.close();

    const destination = await createDatabaseBackup(source, join(directory, "backups"));
    assert.equal((await stat(destination)).mode & 0o777, 0o600);
    const restoredPath = join(directory, "restored", "ocean.db");
    await restoreDatabaseBackup(destination, restoredPath);
    assert.equal((await stat(restoredPath)).mode & 0o777, 0o600);
    const restored = new Database(restoredPath, { readonly: true });
    assert.deepEqual(restored.pragma("quick_check"), [{ quick_check: "ok" }]);
    assert.equal((restored.prepare("SELECT username FROM users WHERE id = ?").get("usr_backup") as { username: string }).username, "backup");
    restored.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("restore refuses to overwrite an existing database", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ocean-restore-existing-"));
  try {
    const source = join(directory, "ocean.db");
    openDatabase(source).close();
    const backup = await createDatabaseBackup(source, join(directory, "backups"));
    const destination = join(directory, "existing.db");
    await writeFile(destination, "keep-me");

    await assert.rejects(restoreDatabaseBackup(backup, destination), /nepřepíše/);
    assert.equal(await readFile(destination, "utf8"), "keep-me");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("restore rejects a corrupted backup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ocean-restore-corrupt-"));
  try {
    const backup = join(directory, "corrupted.backup");
    await writeFile(backup, "not a sqlite database");
    await assert.rejects(restoreDatabaseBackup(backup, join(directory, "restored.db")));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("restore does not change permissions of an existing destination directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ocean-restore-mode-"));
  try {
    const source = join(directory, "ocean.db");
    openDatabase(source).close();
    const backup = await createDatabaseBackup(source, join(directory, "backups"));
    const sharedDirectory = join(directory, "shared");
    await mkdir(sharedDirectory);
    await chmod(sharedDirectory, 0o755);

    await restoreDatabaseBackup(backup, join(sharedDirectory, "restored.db"));
    assert.equal((await stat(sharedDirectory)).mode & 0o777, 0o755);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
