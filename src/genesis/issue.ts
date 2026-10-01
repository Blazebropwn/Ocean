import "dotenv/config";
import { closeSync, fsyncSync, openSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { loadConfig } from "../config.js";
import { openDatabase } from "../db.js";
import { issueGenesisBatch, keyId } from "./service.js";

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--output" || !args[1]) throw new Error("Použití: npm run genesis:issue -- --output /soukromy/adresar/genesis-codes-GENESIS_001.csv");
const config = loadConfig();
if (!config.genesisAdminUserId) throw new Error("Nastav GENESIS_ADMIN_USER_ID na stabilní ID schváleného vlastníka.");
keyId(config.genesisCodeHmacKey ?? "");
// Resolve symlinks before checking the destination. Export can only live in private
// data/ or outside the repository; its basename is excluded from Git and Docker.
const output = join(realpathSync(dirname(resolve(args[1]))), basename(args[1]));
const root = realpathSync(process.cwd()), data = resolve(root, "data") + sep;
if (!/^genesis-codes-[A-Za-z0-9_-]+\.csv$/.test(basename(output))) throw new Error("Export musí mít název genesis-codes-<wave>.csv.");
if (output.startsWith(root + sep) && !output.startsWith(data)) throw new Error("Export musí být v soukromém data/ nebo mimo repozitář.");
const db = openDatabase(config.databasePath);
let written = false;
try {
  const count = issueGenesisBatch(db, { adminUserId: config.genesisAdminUserId, hmacKey: config.genesisCodeHmacKey! }, codes => {
    const fd = openSync(output, "wx", 0o600);
    written = true;
    try {
      writeFileSync(fd, "index,code,reward_tide,wave\n" + codes.map(c => `${String(c.genesisNumber).padStart(3, "0")},${c.code},${c.rewardTide},${c.wave}`).join("\n") + "\n");
      fsyncSync(fd);
    } finally { closeSync(fd); }
    const parent = openSync(dirname(output), "r");
    try { fsyncSync(parent); } finally { closeSync(parent); }
  });
  console.log(`Vydáno ${count} Genesis kódů. Soukromý export: ${output}`);
} catch (error) {
  if (written) unlinkSync(output);
  throw error;
} finally { db.close(); }
