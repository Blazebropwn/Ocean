import { resolve } from "node:path";

export type Config = {
  port: number;
  host: string;
  databasePath: string;
  appOrigin: string;
  isProduction: boolean;
  kryptotronSupabaseUrl?: string;
  kryptotronSupabaseKey?: string;
  credentialsEncryptionKey?: string;
  kryptotronSupervisorEnabled?: boolean;
  kryptotronPython?: string;
  trustedProxies?: string[];
  resendApiKey?: string;
  emailFrom?: string;
  telegramBotToken?: string;
  telegramBotUsername?: string;
  manualApprovalEnabled?: boolean;
  offsiteBackupEnabled?: boolean;
  backupEncryptionKey?: string;
  offsiteBackupTime?: string;
  offsiteBackupTimeZone?: string;
  offsiteBackupS3Endpoint?: string;
  offsiteBackupS3Region?: string;
  offsiteBackupS3Bucket?: string;
  offsiteBackupS3AccessKeyId?: string;
  offsiteBackupS3SecretAccessKey?: string;
  offsiteBackupS3Prefix?: string;
};

export function loadConfig(env = process.env): Config {
  return {
    port: Number(env.PORT ?? 3000),
    host: env.HOST ?? "127.0.0.1",
    databasePath: resolve(env.DATABASE_PATH ?? "./data/ocean.db"),
    appOrigin: env.APP_ORIGIN ?? "http://localhost:3000",
    isProduction: env.NODE_ENV === "production",
    kryptotronSupabaseUrl: env.KRYPTOTRON_SUPABASE_URL,
    kryptotronSupabaseKey: env.KRYPTOTRON_SUPABASE_KEY,
    credentialsEncryptionKey: env.OCEAN_CREDENTIALS_KEY,
    kryptotronSupervisorEnabled: env.KRYPTOTRON_SUPERVISOR_ENABLED === "true",
    kryptotronPython: env.KRYPTOTRON_PYTHON ?? "python",
    trustedProxies: env.TRUST_PROXY?.split(",").map((value) => value.trim()).filter(Boolean),
    resendApiKey: env.RESEND_API_KEY,
    emailFrom: env.EMAIL_FROM,
    telegramBotToken: env.OCEAN_TELEGRAM_BOT_TOKEN,
    telegramBotUsername: env.OCEAN_TELEGRAM_BOT_USERNAME,
    manualApprovalEnabled: env.OCEAN_MANUAL_APPROVAL_ENABLED === "true",
    offsiteBackupEnabled: env.OCEAN_OFFSITE_BACKUP_ENABLED === "true",
    backupEncryptionKey: env.OCEAN_BACKUP_KEY,
    offsiteBackupTime: env.OCEAN_OFFSITE_BACKUP_TIME ?? "03:15",
    offsiteBackupTimeZone: env.OCEAN_OFFSITE_BACKUP_TIME_ZONE ?? "Europe/Prague",
    offsiteBackupS3Endpoint: env.OCEAN_BACKUP_S3_ENDPOINT,
    offsiteBackupS3Region: env.OCEAN_BACKUP_S3_REGION ?? "auto",
    offsiteBackupS3Bucket: env.OCEAN_BACKUP_S3_BUCKET,
    offsiteBackupS3AccessKeyId: env.OCEAN_BACKUP_S3_ACCESS_KEY_ID,
    offsiteBackupS3SecretAccessKey: env.OCEAN_BACKUP_S3_SECRET_ACCESS_KEY,
    offsiteBackupS3Prefix: env.OCEAN_BACKUP_S3_PREFIX ?? "ocean",
  };
}
