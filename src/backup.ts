import "dotenv/config";
import { loadConfig } from "./config.js";
import { createDatabaseBackup } from "./backup-lib.js";

const config = loadConfig();
const retentionDays = Math.max(1, Number(process.env.BACKUP_RETENTION_DAYS ?? 30));
const destination = await createDatabaseBackup(config.databasePath, process.env.BACKUP_DIRECTORY, retentionDays);
console.log(destination);
