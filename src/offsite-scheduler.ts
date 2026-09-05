import type { FastifyBaseLogger } from "fastify";
import { dirname, join, resolve } from "node:path";
import type { Config } from "./config.js";
import { backupEncryptionKey, createOffsiteBackup, readBackupScheduleState, writeBackupScheduleState } from "./offsite-backup-lib.js";
import { createS3ObjectStore, offsiteStoreConfigFromApp } from "./offsite-store.js";

type SchedulerLogger = Pick<FastifyBaseLogger, "info" | "error">;
const CHECK_INTERVAL_MS = 15 * 60_000;

function localParts(now: Date, timeZone: string) {
  const values = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now).map((part) => [part.type, part.value]));
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    time: `${values.hour}:${values.minute}`,
  };
}

export function validateBackupSchedule(time: string, timeZone: string) {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error("OCEAN_OFFSITE_BACKUP_TIME musí mít formát HH:MM.");
  localParts(new Date(), timeZone);
}

export function isBackupDue(now: Date, lastSuccessDate: string | undefined, time: string, timeZone: string) {
  validateBackupSchedule(time, timeZone);
  const local = localParts(now, timeZone);
  return local.date !== lastSuccessDate && local.time >= time;
}

export function startOffsiteBackupScheduler(config: Config, logger: SchedulerLogger) {
  if (!config.offsiteBackupEnabled) return { stop() {} };

  let stopped = false;
  let running = false;
  let timer: NodeJS.Timeout | undefined;
  const time = config.offsiteBackupTime ?? "03:15";
  const timeZone = config.offsiteBackupTimeZone ?? "Europe/Prague";
  const backupDirectory = resolve(process.env.BACKUP_DIRECTORY ?? join(dirname(config.databasePath), "backups"));
  const statePath = join(backupDirectory, ".offsite-backup-state.json");
  const retentionValue = Number(process.env.BACKUP_RETENTION_DAYS ?? 30);
  const retentionDays = Number.isFinite(retentionValue) ? Math.max(1, retentionValue) : 30;

  let encryptionKey: Buffer;
  let storeConfig: ReturnType<typeof offsiteStoreConfigFromApp>;
  try {
    validateBackupSchedule(time, timeZone);
    encryptionKey = backupEncryptionKey(config.backupEncryptionKey);
    storeConfig = offsiteStoreConfigFromApp(config);
  } catch (error) {
    logger.error({ err: error }, "Vzdálené zálohy nemají platnou konfiguraci");
    return { stop() {} };
  }
  const store = createS3ObjectStore(storeConfig);

  const check = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const now = new Date();
      const lastSuccessDate = await readBackupScheduleState(statePath);
      if (!isBackupDue(now, lastSuccessDate, time, timeZone)) return;
      const result = await createOffsiteBackup({
        databasePath: config.databasePath,
        backupDirectory,
        retentionDays,
        encryptionKey,
        store,
        prefix: storeConfig.prefix,
      });
      const today = localParts(now, timeZone).date;
      await writeBackupScheduleState(statePath, today);
      logger.info({ objectKey: result.objectKey, encryptedSize: result.encryptedSize }, "Vzdálená záloha byla vytvořena a obnovena při kontrole");
    } catch (error) {
      logger.error({ err: error }, "Vzdálená záloha selhala");
    } finally {
      running = false;
    }
  };

  void check();
  timer = setInterval(() => void check(), CHECK_INTERVAL_MS);
  timer.unref();
  return {
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
    },
  };
}
