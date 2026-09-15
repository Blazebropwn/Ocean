import type { FastifyBaseLogger } from "fastify";
import type { Config } from "./config.js";
import type { OceanDatabase } from "./db.js";
import { AgentRepository } from "./agents/repository.js";
import { AgentRunError, PortfolioRiskAgentRunner } from "./agents/runner.js";
import type { PortfolioProvider } from "./portfolio/provider.js";

type SchedulerLogger = Pick<FastifyBaseLogger, "info" | "error">;
const CHECK_INTERVAL_MS = 60_000;

export function agentLocalParts(now: Date, timeZone: string) {
  const values = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now).map((part) => [part.type, part.value]));
  return { date: `${values.year}-${values.month}-${values.day}`, time: `${values.hour}:${values.minute}` };
}

export function validateAgentSchedule(time: string, timeZone: string) {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error("OCEAN_AGENT_DAILY_RUN_TIME musí mít formát HH:MM.");
  agentLocalParts(new Date(), timeZone);
}

export function isAgentRunDue(now: Date, priorRunTimestamps: string[], time: string, timeZone: string) {
  validateAgentSchedule(time, timeZone);
  const local = agentLocalParts(now, timeZone);
  return local.time >= time && !priorRunTimestamps.some((timestamp) => {
    const normalized = /^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}$/.test(timestamp)
      ? `${timestamp.replace(" ", "T")}Z`
      : timestamp;
    return agentLocalParts(new Date(normalized), timeZone).date === local.date;
  });
}

export async function runScheduledAgentCheck(options: {
  config: Config;
  repository: AgentRepository;
  runner: PortfolioRiskAgentRunner;
  logger: SchedulerLogger;
  now?: Date;
}) {
  const now = options.now ?? new Date();
  const time = options.config.agentDailyRunTime ?? "10:02";
  const timeZone = options.config.agentDailyRunTimeZone ?? "Europe/Prague";
  validateAgentSchedule(time, timeZone);
  const since = new Date(now.getTime() - 48 * 60 * 60_000).toISOString();

  for (const agent of options.repository.listSchedulablePortfolioRiskAgents(Boolean(options.config.manualApprovalEnabled))) {
    if (options.repository.hasRunningRun(agent.id)) continue;
    if (!isAgentRunDue(now, options.repository.scheduledRunDates(agent.id, since), time, timeZone)) continue;
    try {
      const run = await options.runner.run(agent.id, "scheduled");
      options.logger.info({ agentId: agent.id, runId: run.id }, "Denní Risk Agent run byl ověřen");
    } catch (error) {
      options.logger.error({ err: error, agentId: agent.id, runId: error instanceof AgentRunError ? error.runId : null }, "Denní Risk Agent run selhal");
    }
  }
}

export function startAgentScheduler(config: Config, db: OceanDatabase, portfolioProvider: PortfolioProvider, logger: SchedulerLogger) {
  if (!config.agentSchedulerEnabled) return { stop() {} };
  try {
    validateAgentSchedule(config.agentDailyRunTime ?? "10:02", config.agentDailyRunTimeZone ?? "Europe/Prague");
  } catch (error) {
    logger.error({ err: error }, "Risk Agent scheduler nemá platnou konfiguraci");
    return { stop() {} };
  }

  const repository = new AgentRepository(db);
  const runner = new PortfolioRiskAgentRunner(repository, portfolioProvider);
  let stopped = false;
  let running = false;
  let timer: NodeJS.Timeout | undefined;
  const check = async () => {
    if (stopped || running) return;
    running = true;
    try { await runScheduledAgentCheck({ config, repository, runner, logger }); }
    finally { running = false; }
  };
  void check();
  timer = setInterval(() => void check(), CHECK_INTERVAL_MS);
  timer.unref();
  return { stop() { stopped = true; if (timer) clearInterval(timer); } };
}
