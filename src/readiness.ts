import type { Config } from "./config.js";
import { credentialsKey } from "./credentials.js";
import type { OceanDatabase } from "./db.js";
import { backupEncryptionKey } from "./offsite-backup-lib.js";
import { offsiteStoreConfigFromApp } from "./offsite-store.js";
import { validateBackupSchedule } from "./offsite-scheduler.js";

export function readinessIssues(config: Config, db: OceanDatabase) {
  const issues: string[] = [];
  const integrity = db.pragma("quick_check", { simple: true });
  if (integrity !== "ok") issues.push("Databáze neprošla kontrolou integrity.");

  const credentials = (db.prepare("SELECT COUNT(*) AS count FROM kryptotron_credentials").get() as { count: number }).count;
  if (credentials > 0) {
    try { credentialsKey(config.credentialsEncryptionKey); }
    catch { issues.push("Nelze otevřít uložená Binance připojení."); }
  }
  if (config.kryptotronSupervisorEnabled && (!config.kryptotronSupabaseUrl || !config.kryptotronSupabaseKey)) {
    issues.push("Supervisor nemá úložiště stavů.");
  }
  if (config.isProduction && !config.manualApprovalEnabled && (!config.resendApiKey || !config.emailFrom)) {
    issues.push("Produkční e-mail není nastaven.");
  }
  if (config.telegramBotToken && !config.telegramBotUsername) issues.push("Telegram bot nemá veřejné uživatelské jméno.");
  if (config.offsiteBackupEnabled) {
    try {
      backupEncryptionKey(config.backupEncryptionKey);
      offsiteStoreConfigFromApp(config);
      validateBackupSchedule(config.offsiteBackupTime ?? "03:15", config.offsiteBackupTimeZone ?? "Europe/Prague");
    } catch {
      issues.push("Vzdálené zálohy nemají platnou konfiguraci.");
    }
  }
  return issues;
}
