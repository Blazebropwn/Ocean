import Database from "better-sqlite3";
import type { Config } from "./config.js";
import { credentialsKeys } from "./credentials.js";

type Check = { code: string; ok: boolean; detail: string };
type Instance = {
  id: string;
  environment: string;
  status: string;
  remote_state_key: string | null;
  approved_at: string | null;
  has_credentials: number;
};

/** Local configuration only: no server startup, migrations, network or orders. */
export function testnetPreflight(config: Config, instanceId?: string) {
  const checks: Check[] = [];
  const check = (code: string, ok: boolean, detail: string) => checks.push({ code, ok, detail });
  check("MAINNET_DISABLED", config.kryptotronMainnetEnabled !== true,
    "Testovací proces vyžaduje KRYPTOTRON_MAINNET_ENABLED=false.");
  check("SUPERVISOR_CONFIGURED", config.kryptotronSupervisorEnabled === true,
    "Testovací proces potřebuje zapnutý supervisor; tento příkaz ho nespouští.");
  check("BROKER_CONFIGURED", Boolean(config.kryptotronSupabaseUrl && config.kryptotronSupabaseKey),
    "Broker vyžaduje Supabase URL a klíč; dostupnost se zde neověřuje.");
  let encryptionConfigured = false;
  try { credentialsKeys(config); encryptionConfigured = true; } catch { /* Do not print configuration or errors. */ }
  check("ENCRYPTION_CONFIGURED", encryptionConfigured,
    "Aktivní i případný předchozí šifrovací klíč musí mít platný formát.");

  let db: Database.Database | undefined;
  try {
    // Deliberately bypass openDatabase(): that function migrates and changes permissions.
    db = new Database(config.databasePath, { readonly: true, fileMustExist: true });
    const rows = db.prepare(`SELECT i.id, i.environment, i.status, i.remote_state_key, u.approved_at,
      CASE WHEN length(c.api_key_ciphertext) > 0 AND length(c.api_key_iv) > 0
        AND length(c.api_key_tag) > 0 AND length(c.api_secret_ciphertext) > 0
        AND length(c.api_secret_iv) > 0 AND length(c.api_secret_tag) > 0
        THEN 1 ELSE 0 END AS has_credentials
      FROM kryptotron_instances i JOIN users u ON u.id = i.user_id
      LEFT JOIN kryptotron_credentials c ON c.instance_id = i.id`).all() as Instance[];
    check("DATABASE_READABLE", true, "Existující databáze byla otevřena pouze ke čtení.");
    check("ISOLATED_DATABASE", rows.every((row) => row.environment === "testnet"),
      "Acceptance proces musí používat samostatnou databázi bez mainnet instancí.");
    const candidates = rows.filter((row) => row.environment === "testnet");
    const selected = instanceId ? rows.find((row) => row.id === instanceId)
      : candidates.length === 1 ? candidates[0] : undefined;
    check("TESTNET_INSTANCE_SELECTED", selected?.environment === "testnet",
      "Připoj samostatný testnet účet; při více instancích vyber --instance ID.");
    if (selected?.environment === "testnet") {
      check("PERSONAL_STATE", selected.remote_state_key === selected.id,
        "Instance musí mít vlastní broker state key, nikoliv sdílený legacy stav.");
      check("INSTANCE_CONNECTED", ["provisioning", "connected"].includes(selected.status),
        "Připojení musí být ve stavu provisioning nebo connected.");
      check("CREDENTIALS_STORED", selected.has_credentials === 1,
        "Testnet klíče musí být uložené přes připojovací formulář; platnost ověří živý test.");
      check("ACCESS_APPROVED", !config.manualApprovalEnabled || Boolean(selected.approved_at),
        "Pokud je zapnuté ruční schvalování, musí být testovací účet schválený.");
    }
  } catch {
    check("DATABASE_READABLE", false,
      "Databáze chybí, není čitelná nebo nemá očekávané schéma. Žádná migrace nebyla spuštěna.");
  } finally {
    db?.close();
  }
  return {
    scope: "local-configuration-only",
    status: checks.every((item) => item.ok) ? "CONFIGURED" : "BLOCKED",
    liveAcceptance: "NOT_RUN",
    checks,
  };
}
