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
  };
}
