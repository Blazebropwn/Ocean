import "dotenv/config";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { createDatabaseBackup } from "./backup-lib.js";
import { restoreDatabaseBackup } from "./restore-lib.js";

const config = loadConfig();
const retentionValue = Number(process.env.BACKUP_RETENTION_DAYS ?? 30);
const retentionDays = Number.isFinite(retentionValue) ? Math.max(1, retentionValue) : 30;
const temporaryDirectory = await mkdtemp(join(tmpdir(), "ocean-restore-drill-"));

try {
  const backup = await createDatabaseBackup(config.databasePath, process.env.BACKUP_DIRECTORY, retentionDays);
  const result = await restoreDatabaseBackup(backup, join(temporaryDirectory, "ocean-restored.db"));
  const rows = Object.values(result.snapshot.tables).reduce((sum, count) => sum + count, 0);
  console.log(`Obnova ověřena: ${Object.keys(result.snapshot.tables).length} tabulek, ${rows} řádků.`);
  console.log(`Záloha: ${backup}`);
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
