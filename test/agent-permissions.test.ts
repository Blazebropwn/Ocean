import test from "node:test";
import assert from "node:assert/strict";
import {
  AGENT_001_PERMISSION_POLICY,
  AgentAuthorizationError,
  authorizeAgentCapability,
  parseAgentPermissionPolicy,
  type AgentAuthorizationContext,
  type AgentAuthorizationErrorCode,
} from "../src/agents/permissions.js";

function context(overrides: {
  agent?: Partial<AgentAuthorizationContext["agent"]>;
  run?: Partial<AgentAuthorizationContext["run"]>;
} = {}): AgentAuthorizationContext {
  return {
    agent: {
      mode: "simulation",
      status: "active",
      killSwitchAt: null,
      permissions: AGENT_001_PERMISSION_POLICY,
      maxActionsPerRun: 5,
      maxCostMicrounitsPerRun: 0,
      ...overrides.agent,
    },
    run: {
      mode: "simulation",
      status: "running",
      actionCount: 0,
      costMicrounits: 0,
      ...overrides.run,
    },
  };
}

function expectDenied(code: AgentAuthorizationErrorCode, operation: () => unknown) {
  assert.throws(operation, (error) => error instanceof AgentAuthorizationError && error.code === code);
}

test("AGENT-001 policy contains only the five simulation capabilities", () => {
  assert.deepEqual(AGENT_001_PERMISSION_POLICY, {
    version: 1,
    mode: "simulation",
    capabilities: [
      "portfolio.read",
      "risk.calculate",
      "report.generate",
      "report.validate",
      "ledger.append",
    ],
  });
  assert.equal((AGENT_001_PERMISSION_POLICY.capabilities as readonly string[]).includes("trade.execute"), false);
});

test("permission policy accepts persisted JSON and rejects unknown or duplicate capabilities", () => {
  assert.deepEqual(parseAgentPermissionPolicy(JSON.stringify(AGENT_001_PERMISSION_POLICY)), AGENT_001_PERMISSION_POLICY);
  expectDenied("INVALID_PERMISSION_POLICY", () => parseAgentPermissionPolicy("not-json"));
  expectDenied("INVALID_PERMISSION_POLICY", () => parseAgentPermissionPolicy({
    version: 1,
    mode: "simulation",
    capabilities: ["portfolio.read", "trade.execute"],
  }));
  expectDenied("INVALID_PERMISSION_POLICY", () => parseAgentPermissionPolicy({
    version: 1,
    mode: "simulation",
    capabilities: ["portfolio.read", "portfolio.read"],
  }));
});

test("authorization permits an explicitly granted simulation capability", () => {
  const policy = authorizeAgentCapability(context(), { capability: "portfolio.read", costMicrounits: 0 });
  assert.equal(policy.version, 1);
});

test("authorization fails closed for paused, disabled, or killed agents", () => {
  expectDenied("AGENT_NOT_ACTIVE", () => authorizeAgentCapability(context({ agent: { status: "paused" } }), { capability: "portfolio.read", costMicrounits: 0 }));
  expectDenied("AGENT_NOT_ACTIVE", () => authorizeAgentCapability(context({ agent: { status: "disabled" } }), { capability: "portfolio.read", costMicrounits: 0 }));
  expectDenied("KILL_SWITCH_ACTIVE", () => authorizeAgentCapability(context({ agent: { killSwitchAt: "2026-09-14T09:00:00.000Z" } }), { capability: "portfolio.read", costMicrounits: 0 }));
});

test("authorization rejects non-simulation and non-running contexts", () => {
  expectDenied("MODE_NOT_ALLOWED", () => authorizeAgentCapability(context({ agent: { mode: "live" } }), { capability: "portfolio.read", costMicrounits: 0 }));
  expectDenied("MODE_NOT_ALLOWED", () => authorizeAgentCapability(context({ run: { mode: "live" } }), { capability: "portfolio.read", costMicrounits: 0 }));
  expectDenied("RUN_NOT_RUNNING", () => authorizeAgentCapability(context({ run: { status: "queued" } }), { capability: "portfolio.read", costMicrounits: 0 }));
});

test("authorization enforces grants, action limits, and cost limits", () => {
  const limitedPolicy = { version: 1, mode: "simulation", capabilities: ["portfolio.read"] };
  expectDenied("CAPABILITY_DENIED", () => authorizeAgentCapability(context({ agent: { permissions: limitedPolicy } }), { capability: "report.generate", costMicrounits: 0 }));
  expectDenied("ACTION_LIMIT_EXCEEDED", () => authorizeAgentCapability(context({ run: { actionCount: 5 } }), { capability: "risk.calculate", costMicrounits: 0 }));
  expectDenied("COST_LIMIT_EXCEEDED", () => authorizeAgentCapability(context({ agent: { maxCostMicrounitsPerRun: 100 }, run: { costMicrounits: 90 } }), { capability: "report.generate", costMicrounits: 11 }));
  expectDenied("INVALID_REQUEST_COST", () => authorizeAgentCapability(context(), { capability: "report.generate", costMicrounits: -1 }));
});

test("ledger append does not consume a domain-action slot but still respects cost budget", () => {
  authorizeAgentCapability(context({ run: { actionCount: 5 } }), { capability: "ledger.append", costMicrounits: 0 });
  expectDenied("COST_LIMIT_EXCEEDED", () => authorizeAgentCapability(context({ run: { actionCount: 5 } }), { capability: "ledger.append", costMicrounits: 1 }));
});

test("authorization rejects corrupt runtime counters instead of bypassing limits", () => {
  expectDenied("INVALID_RUNTIME_STATE", () => authorizeAgentCapability(context({ run: { actionCount: Number.NaN } }), { capability: "portfolio.read", costMicrounits: 0 }));
  expectDenied("INVALID_RUNTIME_STATE", () => authorizeAgentCapability(context({ run: { costMicrounits: -1 } }), { capability: "portfolio.read", costMicrounits: 0 }));
  expectDenied("INVALID_RUNTIME_STATE", () => authorizeAgentCapability(context({ agent: { maxActionsPerRun: 6 } }), { capability: "portfolio.read", costMicrounits: 0 }));
});
