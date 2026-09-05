import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { createDatabaseBackup } from "../src/backup-lib.js";
import { openDatabase } from "../src/db.js";
import { restoreDatabaseBackup } from "../src/restore-lib.js";
import { backupEncryptionKey, createOffsiteBackup, restoreOffsiteBackup, type OffsiteObjectStore } from "../src/offsite-backup-lib.js";
import { isBackupDue, validateBackupSchedule } from "../src/offsite-scheduler.js";

class MemoryObjectStore implements OffsiteObjectStore {
  objects = new Map<string, Buffer>();

  async put(key: string, sourcePath: string) {
    this.objects.set(key, await readFile(sourcePath));
  }

  async get(key: string, destinationPath: string) {
    const object = this.objects.get(key);
    if (!object) throw new Error("missing object");
    await writeFile(destinationPath, object, { flag: "wx", mode: 0o600 });
  }

  async size(key: string) {
    const object = this.objects.get(key);
    if (!object) throw new Error("missing object");
    return object.length;
  }
}

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

test("offsite backup is encrypted and verified through a full remote restore", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ocean-offsite-"));
  try {
    const source = join(directory, "ocean.db");
    const db = openDatabase(source);
    db.prepare("INSERT INTO users (id, email, username, password_hash, role) VALUES (?, ?, ?, ?, 'owner')")
      .run("usr_offsite", "private-backup@example.com", "offsite", "hash");
    db.close();
    const store = new MemoryObjectStore();
    const key = randomBytes(32);
    const backup = await createOffsiteBackup({
      databasePath: source,
      backupDirectory: join(directory, "backups"),
      encryptionKey: key,
      store,
      prefix: "/private/ocean/",
    });

    assert.match(backup.objectKey, /^private\/ocean\/\d{4}\/\d{2}\/\d{2}\/ocean\.db\..+\.backup\.obk$/);
    const encrypted = store.objects.get(backup.objectKey)!;
    assert.ok(!encrypted.includes(Buffer.from("private-backup@example.com")));

    const destination = join(directory, "restored.db");
    await restoreOffsiteBackup({ objectKey: backup.objectKey, destinationPath: destination, encryptionKey: key, store });
    const restored = new Database(destination, { readonly: true });
    assert.equal((restored.prepare("SELECT email FROM users WHERE id = ?").get("usr_offsite") as { email: string }).email, "private-backup@example.com");
    restored.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("offsite restore rejects tampering and never creates the destination", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ocean-offsite-tamper-"));
  try {
    const source = join(directory, "ocean.db");
    openDatabase(source).close();
    const store = new MemoryObjectStore();
    const key = randomBytes(32);
    const backup = await createOffsiteBackup({ databasePath: source, encryptionKey: key, store });
    const encrypted = Buffer.from(store.objects.get(backup.objectKey)!);
    encrypted[Math.floor(encrypted.length / 2)]! ^= 1;
    store.objects.set(backup.objectKey, encrypted);
    const destination = join(directory, "must-not-exist.db");

    await assert.rejects(
      restoreOffsiteBackup({ objectKey: backup.objectKey, destinationPath: destination, encryptionKey: key, store }),
      /nelze ověřit nebo rozšifrovat/,
    );
    await assert.rejects(stat(destination), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("backup key and daily schedule are validated", () => {
  const encoded = randomBytes(32).toString("base64");
  assert.equal(backupEncryptionKey(encoded).length, 32);
  assert.throws(() => backupEncryptionKey("short"), /32 bytů/);
  assert.throws(() => validateBackupSchedule("25:00", "Europe\/Prague"), /HH:MM/);
  assert.throws(() => validateBackupSchedule("03:15", "Invalid\/Zone"));
  assert.equal(isBackupDue(new Date("2026-09-05T01:16:00Z"), "2026-09-04", "03:15", "Europe/Prague"), true);
  assert.equal(isBackupDue(new Date("2026-09-05T01:14:00Z"), "2026-09-04", "03:15", "Europe/Prague"), false);
  assert.equal(isBackupDue(new Date("2026-09-05T20:00:00Z"), "2026-09-05", "03:15", "Europe/Prague"), false);
});
