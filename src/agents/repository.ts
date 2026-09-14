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

function id(prefix: "run" | "led") {
  return `${prefix}_${randomBytes(16).toString("hex")}`;
}

function parseJson(value: string | null): unknown | null {
  return value === null ? null : JSON.parse(value);
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
