import { chmod, mkdir, readdir, stat, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { openDatabase } from "./db.js";
import { inspectDatabase } from "./restore-lib.js";

export async function createDatabaseBackup(databasePath: string, configuredDirectory?: string, retentionDays = 30) {
  if (databasePath === ":memory:") throw new Error("Databázi v paměti nelze zálohovat.");
  const backupDirectory = resolve(configuredDirectory ?? join(dirname(databasePath), "backups"));
  const createdDirectory = await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
  if (createdDirectory) await chmod(backupDirectory, 0o700);

  const timestamp = new Date().toISOString().replaceAll(":", "-").replace(".", "-");
  const destination = join(backupDirectory, `${basename(databasePath)}.${timestamp}.backup`);
  const db = openDatabase(databasePath);
  try {
    await db.backup(destination);
    await chmod(destination, 0o600);
  } finally {
    db.close();
  }
  inspectDatabase(destination);

  const normalizedRetentionDays = Number.isFinite(retentionDays) ? Math.max(1, retentionDays) : 30;
  const cutoff = Date.now() - normalizedRetentionDays * 24 * 60 * 60 * 1000;
  const backupPrefix = `${basename(databasePath)}.`;
  for (const name of await readdir(backupDirectory)) {
    if (!name.startsWith(backupPrefix) || !name.endsWith(".backup")) continue;
    const path = join(backupDirectory, name);
    if ((await stat(path)).mtimeMs < cutoff) await unlink(path);
  }
  return destination;
}
