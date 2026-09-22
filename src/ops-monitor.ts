import type { FastifyBaseLogger } from "fastify";
import type { Config } from "./config.js";
import type { OceanDatabase } from "./db.js";
import { readinessIssues } from "./readiness.js";
import { sendOwnerTelegramAlert } from "./telegram.js";

type MonitorLogger = Pick<FastifyBaseLogger, "info" | "warn" | "error">;
const CHECK_INTERVAL_MS = 15 * 60_000;
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
      const { message, nextState } = evaluateOpsAlert(state, opsIssues(config, db), Date.now());
      state = nextState;
      if (message) await alert(message);
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
