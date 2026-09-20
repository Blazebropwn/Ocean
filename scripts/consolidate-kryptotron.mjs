// Run inside the Ocean container. Secrets arrive only in an encrypted packet.
// Staging does NOT start a worker. Stop the old Railway deployment first.
import "dotenv/config";
import { readFile, writeFile } from "node:fs/promises";
import { createHmac } from "node:crypto";
import { loadConfig } from "../dist/src/config.js";
import { openDatabase } from "../dist/src/db.js";
import { credentialsKey, decryptCredential, encryptCredential } from "../dist/src/credentials.js";
import { verifyBinanceCredentials } from "../dist/src/binance.js";
import { prepareConsolidatedState } from "../dist/src/kryptotron-consolidation.js";
import { createDatabaseBackup } from "../dist/src/backup-lib.js";

const [action, packetPath] = process.argv.slice(2);
if (!["check", "stage", "activate"].includes(action)) throw new Error("Use check|stage <packet> or activate");
const config = loadConfig();
const db = openDatabase(config.databasePath);
const key = credentialsKey(config.credentialsEncryptionKey);
const instance = db.prepare(`SELECT i.*, u.role FROM kryptotron_instances i JOIN users u ON u.id=i.user_id WHERE u.role='owner'`).get();
if (!instance || instance.environment !== "mainnet") throw new Error("Expected one owner mainnet instance");
const headers = { apikey: config.kryptotronSupabaseKey, Authorization: `Bearer ${config.kryptotronSupabaseKey}`, "Content-Type": "application/json" };
async function rows(path) {
  const res = await fetch(`${config.kryptotronSupabaseUrl}/rest/v1/${path}`, { headers, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`State read failed (${res.status})`);
  return await res.json();
}
try {
  if (action === "activate") {
    if (instance.status !== "suspended" || instance.remote_state_key !== "main") throw new Error("Instance is not staged");
    if (!config.kryptotronMainnetEnabled || !config.kryptotronSupervisorEnabled) throw new Error("Supervisor is not configured");
    if ((await rows("bot_state?key=eq.main&select=key")).length) throw new Error("Old state still exists; perform the atomic state/history transfer first");
    const target = (await rows(`bot_state?key=eq.${instance.id}&select=data`))[0]?.data;
    if (!target || target.entries_paused !== true || target.dca?.enabled !== false || target.consolidation?.from !== "main") throw new Error("Target is not safely staged");
    prepareConsolidatedState(target, 0);
    if (!db.prepare("SELECT 1 FROM kryptotron_credentials WHERE instance_id=?").get(instance.id)) throw new Error("Credentials missing");
    db.transaction(() => {
      db.prepare("UPDATE kryptotron_instances SET remote_state_key=id,status='provisioning',updated_at=datetime('now') WHERE id=? AND status='suspended'").run(instance.id);
      db.prepare("INSERT INTO admin_audit_log (actor_user_id,action,subject_user_id,details_json) VALUES (?,'KRYPTOTRON_CONSOLIDATED',?,?)")
        .run(instance.user_id, instance.user_id, JSON.stringify({ instanceId: instance.id, from: "main", entriesPaused: true }));
    })();
    console.log(JSON.stringify({ status: "provisioning", instanceId: instance.id, entriesPaused: true }));
  } else {
    if (instance.remote_state_key !== "main") throw new Error("Owner is already managed by Ocean");
    const packet = JSON.parse(await readFile(packetPath, "utf8"));
    if (packet.instanceId !== instance.id) throw new Error("Packet belongs to another instance");
    const secret = JSON.parse(decryptCredential(packet.encrypted, key, `ocean-consolidation:${instance.id}`));
    await verifyBinanceCredentials(secret.apiKey, secret.apiSecret, "mainnet");
    const query = `timestamp=${Date.now()}&recvWindow=10000`;
    const signature = createHmac("sha256", secret.apiSecret).update(query).digest("hex");
    const response = await fetch(`https://api.binance.com/api/v3/openOrders?${query}&signature=${signature}`, {
      headers: { "X-MBX-APIKEY": secret.apiKey }, signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`Cannot verify open orders (${response.status})`);
    const orders = await response.json();
    if (!Array.isArray(orders)) throw new Error("Invalid order response");
    const source = (await rows("bot_state?key=eq.main&select=*"))[0];
    if (!source?.data) throw new Error("Legacy state missing");
    const staged = prepareConsolidatedState(source.data, orders.length);
    if ((await rows(`bot_state?key=eq.${instance.id}&select=key`)).length) throw new Error("Target already exists");
    if (action === "stage") {
      if (!process.argv.includes("--legacy-stopped")) throw new Error("Stop and verify the legacy Railway service first, then use --legacy-stopped");
      const backup = await createDatabaseBackup(config.databasePath, process.env.BACKUP_DIRECTORY);
      const trades = await rows("bot_trades?instance_id=eq.main&select=*");
      const context = `ocean-consolidation-backup:${instance.id}`;
      const remoteBackup = `${backup}.kryptotron.json.enc`;
      await writeFile(remoteBackup, JSON.stringify({ context, encrypted: encryptCredential(JSON.stringify({ source, trades }), key, context) }), { mode: 0o600, flag: "wx" });
      const persisted = JSON.parse(await readFile(remoteBackup, "utf8"));
      if (decryptCredential(persisted.encrypted, key, context) !== JSON.stringify({ source, trades })) throw new Error("Remote snapshot verification failed");
      const contextBase = `${instance.user_id}:${instance.id}`;
      const api = encryptCredential(secret.apiKey, key, `${contextBase}:api-key`);
      const sec = encryptCredential(secret.apiSecret, key, `${contextBase}:api-secret`);
      db.transaction(() => {
        db.prepare("UPDATE kryptotron_instances SET status='suspended',updated_at=datetime('now') WHERE id=?").run(instance.id);
        db.prepare(`INSERT INTO kryptotron_credentials (instance_id,api_key_ciphertext,api_key_iv,api_key_tag,api_secret_ciphertext,api_secret_iv,api_secret_tag,verified_at)
          VALUES (?,?,?,?,?,?,?,datetime('now'))`).run(instance.id,api.ciphertext,api.iv,api.tag,sec.ciphertext,sec.iv,sec.tag);
      })();
      // The operator transfers bot_state.key and bot_trades.instance_id together
      // in a single Postgres transaction, using this prepared paused state.
      await writeFile(`${backup}.staged-state.json`, JSON.stringify(staged), { mode: 0o600, flag: "wx" });
      console.log(JSON.stringify({ status: "suspended", instanceId: instance.id, sqliteBackup: backup, encryptedStateBackup: remoteBackup, trades: trades.length }));
    } else {
      console.log(JSON.stringify({ ready: true, instanceId: instance.id, openOrders: orders.length, telegramLinked: Boolean(db.prepare("SELECT 1 FROM telegram_connections WHERE user_id=?").get(instance.user_id)) }));
    }
  }
} catch (error) {
  // Do not print HTTP request details, signed URLs, or secret packet contents.
  console.error(error instanceof Error ? error.message : "Consolidation failed");
  process.exitCode = 1;
} finally {
  db.close();
}
