import "dotenv/config";
import { createOffsiteBackup, backupEncryptionKey } from "./offsite-backup-lib.js";
import { loadConfig } from "./config.js";
import { createS3ObjectStore, loadOffsiteStoreConfig } from "./offsite-store.js";

const config = loadConfig();
const storeConfig = loadOffsiteStoreConfig();
const retentionValue = Number(process.env.BACKUP_RETENTION_DAYS ?? 30);
const retentionDays = Number.isFinite(retentionValue) ? Math.max(1, retentionValue) : 30;
const result = await createOffsiteBackup({
  databasePath: config.databasePath,
  backupDirectory: process.env.BACKUP_DIRECTORY,
  retentionDays,
  encryptionKey: backupEncryptionKey(process.env.OCEAN_BACKUP_KEY),
  store: createS3ObjectStore(storeConfig),
  prefix: storeConfig.prefix,
});
const rows = Object.values(result.snapshot.tables).reduce((sum, count) => sum + count, 0);
console.log(`Vzdálená obnova ověřena: ${Object.keys(result.snapshot.tables).length} tabulek, ${rows} řádků.`);
console.log(`Objekt: ${result.objectKey}`);
