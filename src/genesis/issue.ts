import "dotenv/config";
import { closeSync, fsyncSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { loadConfig } from "../config.js";
import { openDatabase } from "../db.js";
import { issueGenesisBatch } from "./service.js";

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--output" || !args[1]) throw new Error("Použití: npm run genesis:issue -- --output /bezpecna/cesta/genesis.csv");
const output = resolve(args[1]);
if (output.startsWith(resolve("public") + sep)) throw new Error("Export Genesis kódů nesmí být ve veřejném adresáři.");
const db = openDatabase(loadConfig().databasePath);
let written = false;
try {
  const count = issueGenesisBatch(db, codes => {
    const fd = openSync(output, "wx", 0o600);
    written = true;
    try {
      writeFileSync(fd, "genesisNumber,code,rewardTide\n" + codes.map(c => `${String(c.genesisNumber).padStart(3, "0")},${c.code},300`).join("\n") + "\n");
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
