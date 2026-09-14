import { randomBytes } from "node:crypto";
import type { OceanDatabase } from "../db.js";
import type { AgentAuthorizationContext } from "./permissions.js";

export type AgentRecord = AgentAuthorizationContext["agent"] & {
  id: string;
  userId: string;
  kind: "portfolio_risk_report_v1";
  name: string;
  goal: string;
};

export type AgentRunRecord = AgentAuthorizationContext["run"] & {
  id: string;
  agentId: string;
  triggerType: "manual" | "scheduled";
  goal: string;
  humanInterventions: number;
};

export type LedgerEntryInput = {
  runId: string;
  sequence: number;
  actionType: string;
  input: unknown;
  output: unknown;
  result: "success" | "failure";
  costMicrounits: number;
  occurredAt: string;
};

export type CompletedRun = {
  id: string;
  status: "succeeded" | "failed" | "cancelled";
  validationStatus: "passed" | "failed";
  actionCount: number;
  costMicrounits: number;
  humanInterventions: number;
  result: unknown | null;
  errorCode: string | null;
  errorMessage: string | null;
};

export type AgentRunSummary = {
  id: string;
  triggerType: "manual" | "scheduled";
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  validationStatus: "pending" | "passed" | "failed";
  actionCount: number;
  costMicrounits: number;
  humanInterventions: number;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  success: boolean;
  ledgerUrl: string;
};

export type AgentCard = {
  id: string;
  name: string;
  status: "active" | "paused" | "disabled";
  goal: string;
  mode: "simulation";
  killSwitchActive: boolean;
  maxActionsPerRun: number;
  maxCostMicrounitsPerRun: number;
  lastRun: AgentRunSummary | null;
};

export type AgentRunDetail = AgentRunSummary & {
  goal: string;
  snapshotId: string | null;
  result: unknown | null;
  error: { code: string; message: string } | null;
  ledger: Array<{
    sequence: number;
    actionType: string;
    input: unknown;
    output: unknown;
    result: "success" | "failure";
    costMicrounits: number;
    occurredAt: string;
  }>;
};

function id(prefix: "run" | "led") {
  return `${prefix}_${randomBytes(16).toString("hex")}`;
}

function parseJson(value: string | null): unknown | null {
  return value === null ? null : JSON.parse(value);
}

function runSummary(row: Record<string, unknown>): AgentRunSummary {
  const runId = String(row.id);
  return {
    id: runId,
    triggerType: row.trigger_type as AgentRunSummary["triggerType"],
    status: row.status as AgentRunSummary["status"],
    validationStatus: row.validation_status as AgentRunSummary["validationStatus"],
    actionCount: Number(row.action_count),
    costMicrounits: Number(row.cost_microunits),
    humanInterventions: Number(row.human_interventions),
    startedAt: row.started_at === null ? null : String(row.started_at),
    completedAt: row.completed_at === null ? null : String(row.completed_at),
    createdAt: String(row.created_at),
    success: row.status === "succeeded" && row.validation_status === "passed",
    ledgerUrl: `/api/agent/runs/${runId}`,
  };
}

export class AgentRepository {
  constructor(private readonly db: OceanDatabase) {}

  getAgent(agentId: string): AgentRecord | null {
    const row = this.db.prepare(`
      SELECT id, user_id, kind, name, goal, mode, status, permissions_json,
             max_actions_per_run, max_cost_microunits_per_run, kill_switch_at
      FROM agents WHERE id = ?
    `).get(agentId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      userId: String(row.user_id),
      kind: "portfolio_risk_report_v1",
      name: String(row.name),
      goal: String(row.goal),
      mode: String(row.mode),
      status: String(row.status),
      permissions: String(row.permissions_json),
      maxActionsPerRun: Number(row.max_actions_per_run),
      maxCostMicrounitsPerRun: Number(row.max_cost_microunits_per_run),
      killSwitchAt: row.kill_switch_at === null ? null : String(row.kill_switch_at),
    };
  }

  getAgentCardForUser(userId: string): AgentCard | null {
    const row = this.db.prepare(`
      SELECT id, name, status, goal, mode, kill_switch_at,
             max_actions_per_run, max_cost_microunits_per_run
      FROM agents WHERE user_id = ? AND kind = 'portfolio_risk_report_v1'
    `).get(userId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const lastRun = this.db.prepare(`
      SELECT id, trigger_type, status, validation_status, action_count,
             cost_microunits, human_interventions, started_at, completed_at, created_at
      FROM agent_runs WHERE agent_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1
    `).get(String(row.id)) as Record<string, unknown> | undefined;
    return {
      id: String(row.id),
      name: String(row.name),
      status: row.status as AgentCard["status"],
      goal: String(row.goal),
      mode: "simulation",
      killSwitchActive: row.kill_switch_at !== null,
      maxActionsPerRun: Number(row.max_actions_per_run),
      maxCostMicrounitsPerRun: Number(row.max_cost_microunits_per_run),
      lastRun: lastRun ? runSummary(lastRun) : null,
    };
  }

  listRunsForUser(userId: string, limit = 20): AgentRunSummary[] {
    const rows = this.db.prepare(`
      SELECT r.id, r.trigger_type, r.status, r.validation_status, r.action_count,
             r.cost_microunits, r.human_interventions, r.started_at, r.completed_at, r.created_at
      FROM agent_runs r
      JOIN agents a ON a.id = r.agent_id
      WHERE a.user_id = ? AND a.kind = 'portfolio_risk_report_v1'
      ORDER BY r.created_at DESC, r.rowid DESC LIMIT ?
    `).all(userId, limit) as Array<Record<string, unknown>>;
    return rows.map(runSummary);
  }

  getRunDetailForUser(userId: string, runId: string): AgentRunDetail | null {
    const row = this.db.prepare(`
      SELECT r.* FROM agent_runs r
      JOIN agents a ON a.id = r.agent_id
      WHERE r.id = ? AND a.user_id = ? AND a.kind = 'portfolio_risk_report_v1'
    `).get(runId, userId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const entries = this.db.prepare(`
      SELECT sequence, action_type, input_json, output_json, result,
             cost_microunits, occurred_at
      FROM agent_ledger_entries WHERE run_id = ? ORDER BY sequence
    `).all(runId) as Array<Record<string, unknown>>;
    return {
      ...runSummary(row),
      goal: String(row.goal),
      snapshotId: row.snapshot_id === null ? null : String(row.snapshot_id),
      result: parseJson(row.result_json === null ? null : String(row.result_json)),
      error: row.error_code === null ? null : {
        code: String(row.error_code),
        message: String(row.error_message ?? "Run selhal."),
      },
      ledger: entries.map((entry) => ({
        sequence: Number(entry.sequence),
        actionType: String(entry.action_type),
        input: parseJson(String(entry.input_json)),
        output: parseJson(String(entry.output_json)),
        result: entry.result as "success" | "failure",
        costMicrounits: Number(entry.cost_microunits),
        occurredAt: String(entry.occurred_at),
      })),
    };
  }

  createRunningRun(agent: AgentRecord, triggerType: "manual" | "scheduled", startedAt: string): AgentRunRecord {
    const runId = id("run");
    this.db.prepare(`
      INSERT INTO agent_runs (
        id, agent_id, trigger_type, mode, goal, status, validation_status,
        action_count, cost_microunits, human_interventions, started_at
      ) VALUES (?, ?, ?, 'simulation', ?, 'running', 'pending', 0, 0, 0, ?)
    `).run(runId, agent.id, triggerType, agent.goal, startedAt);
    return {
      id: runId,
      agentId: agent.id,
      triggerType,
      mode: "simulation",
      goal: agent.goal,
      status: "running",
      actionCount: 0,
      costMicrounits: 0,
      humanInterventions: 0,
    };
  }

  appendLedgerEntry(run: AgentRunRecord, entry: Omit<LedgerEntryInput, "runId" | "sequence">): void {
    const sequence = run.actionCount + 1;
    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO agent_ledger_entries (
          id, run_id, sequence, action_type, input_json, output_json,
          result, cost_microunits, occurred_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id("led"), run.id, sequence, entry.actionType,
        JSON.stringify(entry.input), JSON.stringify(entry.output),
        entry.result, entry.costMicrounits, entry.occurredAt,
      );
      const update = this.db.prepare(`
        UPDATE agent_runs
        SET action_count = action_count + 1,
            cost_microunits = cost_microunits + ?
        WHERE id = ? AND status = 'running' AND action_count = ?
      `).run(entry.costMicrounits, run.id, run.actionCount);
      if (update.changes !== 1) throw new Error("Run se během zápisu ledgeru změnil.");
    })();
    run.actionCount = sequence;
    run.costMicrounits += entry.costMicrounits;
  }

  succeedRun(run: AgentRunRecord, snapshotId: string, result: unknown, completedAt: string): void {
    const update = this.db.prepare(`
      UPDATE agent_runs
      SET status = 'succeeded', validation_status = 'passed', snapshot_id = ?,
          result_json = ?, error_code = NULL, error_message = NULL, completed_at = ?
      WHERE id = ? AND status = 'running'
    `).run(snapshotId, JSON.stringify(result), completedAt, run.id);
    if (update.changes !== 1) throw new Error("Běžící run se nepodařilo dokončit.");
    run.status = "succeeded";
  }

  failRun(run: AgentRunRecord, errorCode: string, errorMessage: string, completedAt: string): void {
    const update = this.db.prepare(`
      UPDATE agent_runs
      SET status = 'failed', validation_status = 'failed', error_code = ?,
          error_message = ?, completed_at = ?
      WHERE id = ? AND status = 'running'
    `).run(errorCode, errorMessage.slice(0, 1000), completedAt, run.id);
    if (update.changes !== 1) throw new Error("Běžící run se nepodařilo uzavřít jako neúspěšný.");
    run.status = "failed";
  }

  getCompletedRun(runId: string): CompletedRun | null {
    const row = this.db.prepare(`
      SELECT id, status, validation_status, action_count, cost_microunits,
             human_interventions, result_json, error_code, error_message
      FROM agent_runs WHERE id = ? AND status IN ('succeeded', 'failed', 'cancelled')
    `).get(runId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      status: row.status as CompletedRun["status"],
      validationStatus: row.validation_status as CompletedRun["validationStatus"],
      actionCount: Number(row.action_count),
      costMicrounits: Number(row.cost_microunits),
      humanInterventions: Number(row.human_interventions),
      result: parseJson(row.result_json === null ? null : String(row.result_json)),
      errorCode: row.error_code === null ? null : String(row.error_code),
      errorMessage: row.error_message === null ? null : String(row.error_message),
    };
  }
}
