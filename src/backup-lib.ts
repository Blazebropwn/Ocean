import { chmod, mkdir, readdir, stat, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { openDatabase } from "./db.js";

export async function createDatabaseBackup(databasePath: string, configuredDirectory?: string, retentionDays = 30) {
  if (databasePath === ":memory:") throw new Error("Databázi v paměti nelze zálohovat.");
  const backupDirectory = resolve(configuredDirectory ?? join(dirname(databasePath), "backups"));
  await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
  await chmod(backupDirectory, 0o700);

  const timestamp = new Date().toISOString().replaceAll(":", "-").replace(".", "-");
  const destination = join(backupDirectory, `${basename(databasePath)}.${timestamp}.backup`);
  const db = openDatabase(databasePath);
  try {
    await db.backup(destination);
    await chmod(destination, 0o600);
  } finally {
    db.close();
  }

  const cutoff = Date.now() - Math.max(1, retentionDays) * 24 * 60 * 60 * 1000;
  for (const name of await readdir(backupDirectory)) {
    if (!name.endsWith(".backup")) continue;
    const path = join(backupDirectory, name);
    if ((await stat(path)).mtimeMs < cutoff) await unlink(path);
  }
  return destination;
}
