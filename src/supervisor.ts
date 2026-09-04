import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { FastifyBaseLogger } from "fastify";
import type { Config } from "./config.js";
import { credentialsKey, decryptCredential } from "./credentials.js";
import type { OceanDatabase } from "./db.js";
import { workerAccessToken } from "./worker-auth.js";

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
  approved_at: string | null;
};

type SupervisorLogger = Pick<FastifyBaseLogger, "info" | "warn" | "error">;
type ManagedChild = { process: ChildProcess; startedAt: number; lastHeartbeatAt: number; ready: boolean; stopping: boolean };
const POLL_MS = 10_000;
const MAX_RESTART_DELAY_MS = 5 * 60_000;
const STARTUP_TIMEOUT_MS = 7 * 60_000;
const HEARTBEAT_TIMEOUT_MS = 3 * 60_000;

export function restartDelayMs(failures: number) {
  return Math.min(POLL_MS * (2 ** Math.max(0, failures - 1)), MAX_RESTART_DELAY_MS);
}

export function workerHeartbeatExpired(worker: Pick<ManagedChild, "ready" | "startedAt" | "lastHeartbeatAt">, now = Date.now()) {
  const deadline = worker.ready ? worker.lastHeartbeatAt + HEARTBEAT_TIMEOUT_MS : worker.startedAt + STARTUP_TIMEOUT_MS;
  return now > deadline;
}

export function isRunnablePersonalInstance(instance: Pick<RunnableInstance, "id" | "environment"> & { status: string; remote_state_key: string | null }) {
  return instance.environment === "testnet"
    && instance.remote_state_key === instance.id
    && ["provisioning", "connected", "error"].includes(instance.status);
}

export function canRunPersonalInstance(
  instance: Pick<RunnableInstance, "id" | "environment" | "approved_at"> & { status: string; remote_state_key: string | null },
  manualApprovalEnabled = false,
) {
  return isRunnablePersonalInstance(instance) && (!manualApprovalEnabled || Boolean(instance.approved_at));
}

export function workerEnvironment(base: NodeJS.ProcessEnv, instance: Pick<RunnableInstance, "id" | "environment">, apiKey: string, apiSecret: string, config: Config, accessToken?: string): NodeJS.ProcessEnv {
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
    SUPABASE_URL: accessToken ? "" : config.kryptotronSupabaseUrl ?? "",
    SUPABASE_KEY: accessToken ? "" : config.kryptotronSupabaseKey ?? "",
    OCEAN_STATE_URL: accessToken ? `http://127.0.0.1:${config.port}/internal/kryptotron` : "",
    OCEAN_STATE_TOKEN: accessToken ?? "",
    TELEGRAM_TOKEN: "",
    TELEGRAM_CHAT_ID: "",
    DCA_ENABLED: "false",
    STREAK_ENABLED: "false",
  };
}

export function startKryptotronSupervisor(config: Config, db: OceanDatabase, logger: SupervisorLogger) {
  const children = new Map<string, ManagedChild>();
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
    const now = Date.now();
    const instances = db.prepare(`
      SELECT i.id, i.user_id, i.environment, i.status, i.remote_state_key,
        u.approved_at,
        c.api_key_ciphertext, c.api_key_iv, c.api_key_tag,
        c.api_secret_ciphertext, c.api_secret_iv, c.api_secret_tag
      FROM kryptotron_instances i
      JOIN kryptotron_credentials c ON c.instance_id = i.id
      JOIN users u ON u.id = i.user_id
    `).all() as Array<RunnableInstance & { status: string; remote_state_key: string | null }>;
    const runnableInstances = instances.filter((instance) => canRunPersonalInstance(instance, config.manualApprovalEnabled));
    const runnableIds = new Set(runnableInstances.map((instance) => instance.id));

    for (const [instanceId, child] of children) {
      if (!runnableIds.has(instanceId) && !child.stopping) {
        child.stopping = true;
        logger.info({ instanceId }, "Osobní Kryptotron už není aktivní a bude ukončen");
        child.process.kill("SIGTERM");
      } else if (!child.stopping && workerHeartbeatExpired(child, now)) {
        child.stopping = true;
        logger.warn({ instanceId }, "Osobní Kryptotron přestal odpovídat a bude restartován");
        child.process.kill("SIGTERM");
      }
    }

    for (const instance of runnableInstances) {
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
          env: workerEnvironment(process.env, instance, apiKey, apiSecret, config, workerAccessToken(encryptionKey, instance.id)),
          stdio: ["ignore", "pipe", "pipe"],
        });
        const managed = { process: child, startedAt: Date.now(), lastHeartbeatAt: Date.now(), ready: false, stopping: false };
        children.set(instance.id, managed);
        db.prepare("UPDATE kryptotron_instances SET status = 'provisioning', updated_at = datetime('now') WHERE id = ?").run(instance.id);
        logger.info({ instanceId: instance.id, pid: child.pid }, "Osobní Kryptotron se spouští");

        const handleOutput = (chunk: Buffer) => {
          const output = chunk.toString("utf8");
          if (output.includes("OCEAN_HEARTBEAT")) managed.lastHeartbeatAt = Date.now();
          if (output.includes("Kryptotron připraven")) {
            managed.ready = true;
            managed.lastHeartbeatAt = Date.now();
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
      for (const child of children.values()) child.process.kill("SIGTERM");
      children.clear();
    },
  };
}
