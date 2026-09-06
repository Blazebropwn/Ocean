import type { OceanDatabase } from "./db.js";

type MaintenanceLogger = { info(value: unknown, message?: string): void; error(value: unknown, message?: string): void };

export function purgeExpiredRecords(db: OceanDatabase) {
  const sweep = db.transaction(() => ({
    sessions: db.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')").run().changes,
    emailVerifications: db.prepare("DELETE FROM email_verification_tokens WHERE expires_at <= datetime('now')").run().changes,
    passwordResets: db.prepare("DELETE FROM password_reset_tokens WHERE expires_at <= datetime('now')").run().changes,
    telegramPairings: db.prepare("DELETE FROM telegram_pairings WHERE expires_at <= datetime('now')").run().changes,
  }));
  return sweep();
}

export function startMaintenance(db: OceanDatabase, logger: MaintenanceLogger, intervalMs = 60 * 60 * 1000) {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const run = () => {
    if (stopped) return;
    try {
      const removed = purgeExpiredRecords(db);
      const total = removed.sessions + removed.emailVerifications + removed.passwordResets + removed.telegramPairings;
      if (total > 0) logger.info({ removed }, "Expirované relace a tokeny byly odstraněny");
    } catch (error) {
      logger.error({ err: error }, "Údržbový úklid se nepodařil");
    }
    timer = setTimeout(run, intervalMs);
    timer.unref();
  };
  run();
  return { stop() { stopped = true; if (timer) clearTimeout(timer); } };
}
