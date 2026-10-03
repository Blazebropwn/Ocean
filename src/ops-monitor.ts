import type { FastifyBaseLogger } from "fastify";
import type { Config } from "./config.js";
import type { OceanDatabase } from "./db.js";
import { readinessIssues } from "./readiness.js";
import { sendOwnerTelegramAlert } from "./telegram.js";
import { loadKryptotronState } from "./kryptotron.js";

type MonitorLogger = Pick<FastifyBaseLogger, "info" | "warn" | "error">;
const CHECK_INTERVAL_MS = 60_000;
const ALERT_REMINDER_MS = 60 * 60_000;
const STUCK_INSTANCE_THRESHOLD_MS = 30 * 60_000;

/** Kryptotron instances the supervisor keeps failing to (re)start, long enough that its own
 * restart-with-backoff loop clearly isn't recovering on its own. */
export function stuckInstanceIssues(db: OceanDatabase, now = new Date()) {
  const threshold = new Date(now.getTime() - STUCK_INSTANCE_THRESHOLD_MS).toISOString();
  const stuck = db.prepare(`
    SELECT i.id, u.username FROM kryptotron_instances i JOIN users u ON u.id = i.user_id
    WHERE i.status = 'error' AND i.updated_at <= ?
  `).all(threshold) as Array<{ id: string; username: string }>;
  return stuck.map((instance) => `Kryptotron uživatele ${instance.username} (${instance.id}) je v chybovém stavu déle než 30 minut.`);
}

export function opsIssues(config: Config, db: OceanDatabase, now = new Date()) {
  return [...readinessIssues(config, db), ...stuckInstanceIssues(db, now)];
}

export function workerStateIssues(state: Record<string, unknown> | null, label: string, now = Date.now()): string[] {
  if (!state) return [`${label}: vzdálený stav není dostupný.`];
  const heartbeat = typeof state.last_heartbeat_at === "string" ? Date.parse(state.last_heartbeat_at) : NaN;
  const issues: string[] = [];
  if (!Number.isFinite(heartbeat) || now-heartbeat > 180_000 || heartbeat > now+60_000) issues.push(`${label}: heartbeat není aktuální.`);
  if (state.safe_mode === true) {
    const check = state.reconciliation as { issues?: Array<{ code?: string }> } | undefined;
    const onlyProtection = Array.isArray(check?.issues) && check.issues.length > 0 && check.issues.every(i => i?.code === "PROTECTION_ERROR");
    issues.push(onlyProtection
      ? `${label}: bezpečnostní režim — chybí ochranné objednávky. Vlastník účtu musí v Oceanu potvrdit obnovení ochrany; samotné /resume nestačí.`
      : `${label}: bezpečnostní režim, ověř stav účtu a ochrany.`);
  }
  if (Array.isArray(state.pending_trade_logs) && state.pending_trade_logs.length) issues.push(`${label}: historie obchodů čeká na uložení.`);
  if (state.runtime_status === "degraded" && state.safe_mode !== true) issues.push(`${label}: worker hlásí provozní chybu.`);
  return issues;
}

async function workerIssues(config: Config, db: OceanDatabase) {
  if (!config.kryptotronSupabaseUrl || !config.kryptotronSupabaseKey) return [];
  const instances = db.prepare("SELECT id, remote_state_key FROM kryptotron_instances WHERE status = 'connected' AND remote_state_key IS NOT NULL ORDER BY id")
    .all() as Array<{ id: string; remote_state_key: string }>;
  const issues: string[] = [];
  for (const instance of instances) {
    const label = `Kryptotron ${instance.id}`;
    try {
      const state = await loadKryptotronState(config.kryptotronSupabaseUrl, config.kryptotronSupabaseKey, instance.remote_state_key);
      issues.push(...workerStateIssues(state, label));
    } catch { issues.push(`${label}: vzdálený stav není dostupný.`); }
  }
  return issues;
}

export type OpsAlertState = { activeIssuesKey: string; lastAlertAt: number };
export const initialOpsAlertState: OpsAlertState = { activeIssuesKey: "", lastAlertAt: 0 };

/** Decides whether this check should notify the owner: immediately on a new/changed problem,
 * at most once per hour as a reminder while it persists, and once when it clears. Pure — no I/O. */
export function evaluateOpsAlert(state: OpsAlertState, issues: string[], now: number): { message: string | null; nextState: OpsAlertState } {
  if (issues.length === 0) {
    if (!state.activeIssuesKey) return { message: null, nextState: state };
    return { message: "✅ Ocean: provozní kontrola je opět v pořádku.", nextState: { activeIssuesKey: "", lastAlertAt: state.lastAlertAt } };
  }
  const key = issues.join("|");
  if (key === state.activeIssuesKey && now - state.lastAlertAt <= ALERT_REMINDER_MS) {
    return { message: null, nextState: state };
  }
  return {
    message: ["🚨 Ocean: provozní kontrola narazila na problém.", ...issues].join("\n"),
    nextState: { activeIssuesKey: key, lastAlertAt: now },
  };
}

export function startOpsMonitor(
  config: Config,
  db: OceanDatabase,
  logger: MonitorLogger,
  alert: (text: string) => Promise<boolean> = (text) => sendOwnerTelegramAlert(config, db, text),
) {
  if (!config.opsMonitorEnabled) return { stop() {} };
  if (!config.telegramBotToken) {
    logger.warn({}, "Ops monitor je zapnutý, ale Telegram bot není nastaven");
    return { stop() {} };
  }

  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let state = initialOpsAlertState;

  const check = async () => {
    if (stopped) return;
    try {
      const issues = [...opsIssues(config, db), ...await workerIssues(config, db)];
      const { message, nextState } = evaluateOpsAlert(state, issues, Date.now());
      // Failed delivery must remain eligible for retry at the next check.
      if (!message || await alert(message)) state = nextState;
    } catch (error) {
      logger.error({ err: error }, "Ops monitor selhal");
    }
    if (stopped) return;
    timer = setTimeout(check, CHECK_INTERVAL_MS);
    timer.unref();
  };

  check();
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
