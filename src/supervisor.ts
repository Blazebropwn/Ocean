import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { FastifyBaseLogger } from "fastify";
import type { Config } from "./config.js";
import { credentialsKey, decryptCredential } from "./credentials.js";
import type { OceanDatabase } from "./db.js";

type RunnableInstance = {
  id: string;
  user_id: string;
  environment: "testnet" | "mainnet";
  api_key_ciphertext: string;
  api_key_iv: string;
  api_key_tag: string;
  api_secret_ciphertext: string;
  api_secret_iv: string;
  api_secret_tag: string;
};

type SupervisorLogger = Pick<FastifyBaseLogger, "info" | "warn" | "error">;
const POLL_MS = 10_000;
const MAX_RESTART_DELAY_MS = 5 * 60_000;

export function restartDelayMs(failures: number) {
  return Math.min(POLL_MS * (2 ** Math.max(0, failures - 1)), MAX_RESTART_DELAY_MS);
}

export function workerEnvironment(base: NodeJS.ProcessEnv, instance: Pick<RunnableInstance, "id" | "environment">, apiKey: string, apiSecret: string, config: Config): NodeJS.ProcessEnv {
  const inherited = Object.fromEntries(
    ["PATH", "LANG", "LC_ALL", "TZ", "SSL_CERT_FILE", "REQUESTS_CA_BUNDLE", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"]
      .flatMap((name) => base[name] === undefined ? [] : [[name, base[name]]]),
  );
  return {
    ...inherited,
    BINANCE_API_KEY: apiKey,
    BINANCE_API_SECRET: apiSecret,
    TESTNET: String(instance.environment === "testnet"),
    KRYPTOTRON_INSTANCE_ID: instance.id,
    SUPABASE_URL: config.kryptotronSupabaseUrl ?? "",
    SUPABASE_KEY: config.kryptotronSupabaseKey ?? "",
    TELEGRAM_TOKEN: "",
    TELEGRAM_CHAT_ID: "",
    DCA_ENABLED: "false",
    STREAK_ENABLED: "false",
  };
}

export function startKryptotronSupervisor(config: Config, db: OceanDatabase, logger: SupervisorLogger) {
  const children = new Map<string, ChildProcess>();
  const failures = new Map<string, { count: number; retryAt: number }>();
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  if (!config.kryptotronSupervisorEnabled) {
    logger.info("Kryptotron supervisor je vypnutý");
    return { stop() {} };
  }
  if (!config.kryptotronSupabaseUrl || !config.kryptotronSupabaseKey) {
    logger.error("Kryptotron supervisor nelze spustit bez Supabase konfigurace");
    return { stop() {} };
  }

  let encryptionKey: Buffer;
  try {
    encryptionKey = credentialsKey(config.credentialsEncryptionKey);
  } catch (error) {
    logger.error({ err: error }, "Kryptotron supervisor nemá platný šifrovací klíč");
    return { stop() {} };
  }

  const scan = () => {
    if (stopped) return;
    const instances = db.prepare(`
      SELECT i.id, i.user_id, i.environment,
        c.api_key_ciphertext, c.api_key_iv, c.api_key_tag,
        c.api_secret_ciphertext, c.api_secret_iv, c.api_secret_tag
      FROM kryptotron_instances i
      JOIN kryptotron_credentials c ON c.instance_id = i.id
      WHERE i.status IN ('provisioning', 'connected', 'error')
        AND i.remote_state_key = i.id
        AND i.environment = 'testnet'
    `).all() as RunnableInstance[];

    for (const instance of instances) {
      if (children.has(instance.id)) continue;
      const failure = failures.get(instance.id);
      if (failure && failure.retryAt > Date.now()) continue;
      try {
        const context = `${instance.user_id}:${instance.id}`;
        const apiKey = decryptCredential({ ciphertext: instance.api_key_ciphertext, iv: instance.api_key_iv, tag: instance.api_key_tag }, encryptionKey, `${context}:api-key`);
        const apiSecret = decryptCredential({ ciphertext: instance.api_secret_ciphertext, iv: instance.api_secret_iv, tag: instance.api_secret_tag }, encryptionKey, `${context}:api-secret`);
        const workingDirectory = resolve(dirname(config.databasePath), "instances", instance.id);
        mkdirSync(join(workingDirectory, "logs"), { recursive: true, mode: 0o700 });
        const script = resolve(process.cwd(), "services", "kryptotron", "bot.py");
        const child = spawn(config.kryptotronPython ?? "python", [script], {
          cwd: workingDirectory,
          env: workerEnvironment(process.env, instance, apiKey, apiSecret, config),
          stdio: ["ignore", "pipe", "pipe"],
        });
        children.set(instance.id, child);
        db.prepare("UPDATE kryptotron_instances SET status = 'provisioning', updated_at = datetime('now') WHERE id = ?").run(instance.id);
        logger.info({ instanceId: instance.id, pid: child.pid }, "Osobní Kryptotron se spouští");

        const handleOutput = (chunk: Buffer) => {
          if (chunk.toString("utf8").includes("Kryptotron připraven")) {
            failures.delete(instance.id);
            db.prepare("UPDATE kryptotron_instances SET status = 'connected', updated_at = datetime('now') WHERE id = ? AND status = 'provisioning'").run(instance.id);
          }
        };
        child.stdout?.on("data", handleOutput);
        child.stderr?.on("data", handleOutput);
        let terminationHandled = false;
        const markFailed = () => {
          if (terminationHandled) return;
          terminationHandled = true;
          children.delete(instance.id);
          if (stopped) return;
          const count = (failures.get(instance.id)?.count ?? 0) + 1;
          const delay = restartDelayMs(count);
          failures.set(instance.id, { count, retryAt: Date.now() + delay });
          db.prepare("UPDATE kryptotron_instances SET status = 'error', updated_at = datetime('now') WHERE id = ?").run(instance.id);
          logger.warn({ instanceId: instance.id, failures: count, retryInMs: delay }, "Osobní Kryptotron bude znovu spuštěn");
        };
        child.on("error", (error) => {
          markFailed();
          logger.error({ err: error, instanceId: instance.id }, "Osobní Kryptotron se nepodařilo spustit");
        });
        child.on("exit", (code, signal) => {
          markFailed();
          logger.warn({ instanceId: instance.id, code, signal }, "Osobní Kryptotron byl ukončen");
        });
      } catch (error) {
        db.prepare("UPDATE kryptotron_instances SET status = 'error', updated_at = datetime('now') WHERE id = ?").run(instance.id);
        logger.error({ err: error, instanceId: instance.id }, "Osobní Kryptotron nelze připravit");
      }
    }
    timer = setTimeout(scan, POLL_MS);
    timer.unref();
  };

  scan();
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      for (const child of children.values()) child.kill("SIGTERM");
      children.clear();
    },
  };
}
