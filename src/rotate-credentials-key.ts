import "dotenv/config";
import { loadConfig } from "./config.js";
import { openDatabase } from "./db.js";
import { rotateCredentialsKey } from "./rotate-credentials-key-lib.js";

const config = loadConfig();
const db = openDatabase(config.databasePath);
try {
  const result = rotateCredentialsKey(db, config.credentialsEncryptionKey, config.credentialsEncryptionKeyPrevious);
  console.log(`Celkem připojení: ${result.total}`);
  console.log(`Už na aktuálním klíči: ${result.alreadyCurrent}`);
  console.log(`Přešifrováno: ${result.migrated.length}`);
  for (const instanceId of result.migrated) console.log(`  ✓ ${instanceId}`);
  if (result.failed.length > 0) {
    console.error(`Selhalo: ${result.failed.length}`);
    for (const failure of result.failed) console.error(`  ✗ ${failure.instanceId}: ${failure.error}`);
    process.exitCode = 1;
  } else if (result.migrated.length === 0 && result.total > 0) {
    console.log("Všechna připojení jsou už na aktuálním klíči — rotaci lze dokončit odebráním OCEAN_CREDENTIALS_KEY_PREVIOUS.");
  }
} finally {
  db.close();
}
