import "dotenv/config";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { openDatabase } from "./db.js";
import { startKryptotronSupervisor } from "./supervisor.js";
import { startMailer } from "./mailer.js";
import { startTelegramBot } from "./telegram.js";
import { startOffsiteBackupScheduler } from "./offsite-scheduler.js";
import { startMaintenance } from "./maintenance.js";

const config = loadConfig();
const db = openDatabase(config.databasePath);
const app = buildApp(config, db);
const mailer = startMailer(config, db, app.log);
const maintenance = startMaintenance(db, app.log);
let supervisor: ReturnType<typeof startKryptotronSupervisor> | undefined;
let telegram: ReturnType<typeof startTelegramBot> | undefined;
let offsiteBackupScheduler: ReturnType<typeof startOffsiteBackupScheduler> | undefined;

try {
  await app.listen({ port: config.port, host: config.host });
  supervisor = startKryptotronSupervisor(config, db, app.log);
  telegram = startTelegramBot(config, db, app.log);
  offsiteBackupScheduler = startOffsiteBackupScheduler(config, app.log);
} catch (error) {
  supervisor?.stop();
  mailer.stop();
  maintenance.stop();
  telegram?.stop();
  offsiteBackupScheduler?.stop();
  app.log.error(error);
  process.exit(1);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    supervisor?.stop();
    mailer.stop();
    maintenance.stop();
    telegram?.stop();
    offsiteBackupScheduler?.stop();
    await app.close();
    process.exit(0);
  });
}
