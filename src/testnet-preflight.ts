import "dotenv/config";
import { parseArgs } from "node:util";
import { loadConfig } from "./config.js";
import { testnetPreflight } from "./testnet-preflight-lib.js";

try {
  const { values } = parseArgs({ options: { instance: { type: "string" }, help: { type: "boolean" } } });
  if (values.help) {
    console.log("npm run testnet:preflight -- [--instance ID]\nPouze místní konfigurace. Bez zápisů, síťových volání a spuštění workerů.");
  } else {
    const report = testnetPreflight(loadConfig(), values.instance);
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.status === "CONFIGURED" ? 0 : 2;
  }
} catch {
  console.error("Neplatné argumenty. Použij --help.");
  process.exitCode = 2;
}
