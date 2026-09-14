import type { PortfolioProvider } from "../portfolio/provider.js";
import {
  AgentAuthorizationError,
  authorizeAgentCapability,
  type AgentCapability,
} from "./permissions.js";
import { AgentRepository, type AgentRecord, type AgentRunRecord, type CompletedRun } from "./repository.js";
import { createPortfolioRiskReport, validatePortfolioRiskReport } from "./risk-report.js";

export type AgentRunTrigger = "manual" | "scheduled";

export class AgentRunError extends Error {
  constructor(
    public readonly code: "AGENT_NOT_FOUND" | "RUN_FAILED",
    message: string,
    public readonly runId: string | null = null,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AgentRunError";
  }
}

type RunnerClock = { now(): Date };
const systemClock: RunnerClock = { now: () => new Date() };

function publicError(error: unknown): { code: string; message: string } {
  if (error instanceof AgentAuthorizationError) return { code: error.code, message: error.message };
  if (error instanceof Error) return { code: "ACTION_FAILED", message: error.message || "Akce agenta selhala." };
  return { code: "ACTION_FAILED", message: "Akce agenta selhala." };
}

export class PortfolioRiskAgentRunner {
  constructor(
    private readonly repository: AgentRepository,
    private readonly portfolioProvider: PortfolioProvider,
    private readonly clock: RunnerClock = systemClock,
  ) {}

  async run(agentId: string, trigger: AgentRunTrigger): Promise<CompletedRun> {
    const agent = this.repository.getAgent(agentId);
    if (!agent) throw new AgentRunError("AGENT_NOT_FOUND", "Agent nebyl nalezen.");
    const run = this.repository.createRunningRun(agent, trigger, this.clock.now().toISOString());

    try {
      const snapshot = await this.action(agent, run, "portfolio.read", "portfolio_snapshot_loaded", {
        providerId: this.portfolioProvider.id,
        subjectUserId: agent.userId,
        quoteCurrency: "USDC",
      }, async () => {
        const value = await this.portfolioProvider.getSnapshot({ userId: agent.userId, quoteCurrency: "USDC" });
        if (value.subject.userId !== agent.userId) throw new Error("Portfolio provider vrátil snapshot jiného uživatele.");
        return value;
      });

      const report = await this.action(agent, run, "risk.calculate", "risk_metrics_calculated", {
        snapshotId: snapshot.snapshotId,
      }, async () => createPortfolioRiskReport(snapshot, this.clock.now()), (value) => value.metrics);

      await this.action(agent, run, "report.generate", "risk_report_generated", {
        snapshotId: snapshot.snapshotId,
        schemaVersion: report.schemaVersion,
      }, async () => report);

      const validated = await this.action(agent, run, "report.validate", "risk_report_validated", {
        snapshotId: snapshot.snapshotId,
        reportId: report.reportId,
      }, async () => validatePortfolioRiskReport(report, snapshot, this.clock.now()), (value) => ({
        valid: true,
        reportId: value.reportId,
        schemaVersion: value.schemaVersion,
      }));

      this.repository.succeedRun(run, snapshot.snapshotId, validated, this.clock.now().toISOString());
      return this.requireCompletedRun(run.id);
    } catch (error) {
      const failure = publicError(error);
      this.repository.failRun(run, failure.code, failure.message, this.clock.now().toISOString());
      throw new AgentRunError("RUN_FAILED", failure.message, run.id, { cause: error });
    }
  }

  private async action<T>(
    agent: AgentRecord,
    run: AgentRunRecord,
    capability: AgentCapability,
    actionType: string,
    input: unknown,
    operation: () => Promise<T>,
    ledgerOutput: (value: T) => unknown = (value) => value,
  ): Promise<T> {
    authorizeAgentCapability({ agent, run }, { capability, costMicrounits: 0 });
    let value: T;
    try {
      value = await operation();
    } catch (error) {
      const failure = publicError(error);
      this.append(agent, run, actionType, input, failure, "failure");
      throw error;
    }
    this.append(agent, run, actionType, input, ledgerOutput(value), "success");
    return value;
  }

  private append(
    agent: AgentRecord,
    run: AgentRunRecord,
    actionType: string,
    input: unknown,
    output: unknown,
    result: "success" | "failure",
  ) {
    authorizeAgentCapability({ agent, run }, { capability: "ledger.append", costMicrounits: 0 });
    this.repository.appendLedgerEntry(run, {
      actionType,
      input,
      output,
      result,
      costMicrounits: 0,
      occurredAt: this.clock.now().toISOString(),
    });
  }

  private requireCompletedRun(runId: string): CompletedRun {
    const completed = this.repository.getCompletedRun(runId);
    if (!completed) throw new Error("Dokončený run se nepodařilo načíst.");
    return completed;
  }
}
