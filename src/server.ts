import "dotenv/config";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { openDatabase } from "./db.js";
import { startKryptotronSupervisor } from "./supervisor.js";
import { startMailer } from "./mailer.js";

const config = loadConfig();
const db = openDatabase(config.databasePath);
const app = buildApp(config, db);
const supervisor = startKryptotronSupervisor(config, db, app.log);
const mailer = startMailer(config, db, app.log);

try {
  await app.listen({ port: config.port, host: config.host });
} catch (error) {
  supervisor.stop();
  mailer.stop();
  app.log.error(error);
  process.exit(1);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    supervisor.stop();
    mailer.stop();
    await app.close();
    process.exit(0);
  });
}
