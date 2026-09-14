import type { DatabaseMigration } from "../migrate.js";

export const agent001Foundation: DatabaseMigration = {
  version: 2,
  name: "agent_001_foundation",
  up(db) {
    db.exec(`
      CREATE TABLE agents (
        id TEXT PRIMARY KEY
          CHECK (length(id) = 36 AND substr(id, 1, 4) = 'agt_'),
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind TEXT NOT NULL DEFAULT 'portfolio_risk_report_v1'
          CHECK (kind = 'portfolio_risk_report_v1'),
        name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
        goal TEXT NOT NULL CHECK (length(goal) BETWEEN 1 AND 500),
        mode TEXT NOT NULL DEFAULT 'simulation'
          CHECK (mode = 'simulation'),
        status TEXT NOT NULL DEFAULT 'paused'
          CHECK (status IN ('active', 'paused', 'disabled')),
        permissions_json TEXT NOT NULL
          CHECK (json_valid(permissions_json)),
        max_actions_per_run INTEGER NOT NULL DEFAULT 5
          CHECK (max_actions_per_run BETWEEN 3 AND 5),
        max_cost_microunits_per_run INTEGER NOT NULL DEFAULT 0
          CHECK (max_cost_microunits_per_run >= 0),
        kill_switch_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (user_id, kind)
      );
      CREATE INDEX agents_user_id ON agents(user_id);

      CREATE TABLE agent_runs (
        id TEXT PRIMARY KEY
          CHECK (length(id) = 36 AND substr(id, 1, 4) = 'run_'),
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        trigger_type TEXT NOT NULL
          CHECK (trigger_type IN ('manual', 'scheduled')),
        mode TEXT NOT NULL DEFAULT 'simulation'
          CHECK (mode = 'simulation'),
        goal TEXT NOT NULL CHECK (length(goal) BETWEEN 1 AND 500),
        status TEXT NOT NULL DEFAULT 'queued'
          CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
        validation_status TEXT NOT NULL DEFAULT 'pending'
          CHECK (validation_status IN ('pending', 'passed', 'failed')),
        snapshot_id TEXT,
        result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
        error_code TEXT,
        error_message TEXT,
        action_count INTEGER NOT NULL DEFAULT 0
          CHECK (action_count BETWEEN 0 AND 5),
        cost_microunits INTEGER NOT NULL DEFAULT 0
          CHECK (cost_microunits >= 0),
        human_interventions INTEGER NOT NULL DEFAULT 0
          CHECK (human_interventions >= 0),
        started_at TEXT,
        completed_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        CHECK (
          (status = 'queued' AND started_at IS NULL AND completed_at IS NULL)
          OR (status = 'running' AND started_at IS NOT NULL AND completed_at IS NULL)
          OR (status IN ('succeeded', 'failed', 'cancelled') AND started_at IS NOT NULL AND completed_at IS NOT NULL)
        ),
        CHECK (
          (status IN ('queued', 'running') AND validation_status = 'pending')
          OR (status = 'succeeded' AND validation_status = 'passed' AND result_json IS NOT NULL AND error_code IS NULL AND action_count BETWEEN 3 AND 5)
          OR (status IN ('failed', 'cancelled') AND validation_status = 'failed')
        )
      );
      CREATE INDEX agent_runs_agent_created ON agent_runs(agent_id, created_at DESC);
      CREATE INDEX agent_runs_status ON agent_runs(status);

      CREATE TABLE agent_ledger_entries (
        id TEXT PRIMARY KEY
          CHECK (length(id) = 36 AND substr(id, 1, 4) = 'led_'),
        run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL CHECK (sequence BETWEEN 1 AND 5),
        action_type TEXT NOT NULL CHECK (length(action_type) BETWEEN 1 AND 100),
        input_json TEXT NOT NULL CHECK (json_valid(input_json)),
        output_json TEXT NOT NULL CHECK (json_valid(output_json)),
        result TEXT NOT NULL CHECK (result IN ('success', 'failure')),
        cost_microunits INTEGER NOT NULL DEFAULT 0 CHECK (cost_microunits >= 0),
        occurred_at TEXT NOT NULL,
        UNIQUE (run_id, sequence)
      );
      CREATE INDEX agent_ledger_entries_run_sequence
        ON agent_ledger_entries(run_id, sequence);
    `);
  },
};
