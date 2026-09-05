import "dotenv/config";
import { restoreDatabaseBackup } from "./restore-lib.js";

const [backupPath, destinationPath] = process.argv.slice(2);
if (!backupPath || !destinationPath) {
  throw new Error("Použití: npm run restore -- <soubor-zálohy> <nová-cílová-databáze>");
}

const result = await restoreDatabaseBackup(backupPath, destinationPath);
console.log(result.destination);
