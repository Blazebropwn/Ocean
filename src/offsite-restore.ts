import "dotenv/config";
import { backupEncryptionKey, restoreOffsiteBackup } from "./offsite-backup-lib.js";
import { createS3ObjectStore, loadOffsiteStoreConfig } from "./offsite-store.js";

const [objectKey, destinationPath] = process.argv.slice(2);
if (!objectKey || !destinationPath) {
  throw new Error("Použití: npm run restore:offsite -- <klíč-objektu> <nová-cílová-databáze>");
}
const result = await restoreOffsiteBackup({
  objectKey,
  destinationPath,
  encryptionKey: backupEncryptionKey(process.env.OCEAN_BACKUP_KEY),
  store: createS3ObjectStore(loadOffsiteStoreConfig()),
});
const rows = Object.values(result.snapshot.tables).reduce((sum, count) => sum + count, 0);
console.log(`Obnova dokončena: ${result.destination}`);
console.log(`Ověřeno: ${Object.keys(result.snapshot.tables).length} tabulek, ${rows} řádků.`);
