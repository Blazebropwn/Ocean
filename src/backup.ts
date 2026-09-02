import "dotenv/config";
import { chmod, mkdir, readdir, stat, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { loadConfig } from "./config.js";
import { openDatabase } from "./db.js";

const config = loadConfig();
if (config.databasePath === ":memory:") throw new Error("Databázi v paměti nelze zálohovat.");

const backupDirectory = resolve(process.env.BACKUP_DIRECTORY ?? join(dirname(config.databasePath), "backups"));
await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
await chmod(backupDirectory, 0o700);

const timestamp = new Date().toISOString().replaceAll(":", "-").replace(".", "-");
const destination = join(backupDirectory, `${basename(config.databasePath)}.${timestamp}.backup`);
const db = openDatabase(config.databasePath);

try {
  await db.backup(destination);
  await chmod(destination, 0o600);
} finally {
  db.close();
}

const retentionDays = Math.max(1, Number(process.env.BACKUP_RETENTION_DAYS ?? 30));
const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
for (const name of await readdir(backupDirectory)) {
  if (!name.endsWith(".backup")) continue;
  const path = join(backupDirectory, name);
  if ((await stat(path)).mtimeMs < cutoff) await unlink(path);
}

console.log(destination);
