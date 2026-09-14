import { z } from "zod";

export const AGENT_CAPABILITIES = [
  "portfolio.read",
  "risk.calculate",
  "report.generate",
  "report.validate",
  "ledger.append",
] as const;

export type AgentCapability = (typeof AGENT_CAPABILITIES)[number];

export const agentPermissionPolicySchema = z.strictObject({
  version: z.literal(1),
  mode: z.literal("simulation"),
  capabilities: z.array(z.enum(AGENT_CAPABILITIES)).min(1).max(AGENT_CAPABILITIES.length)
    .refine((capabilities) => new Set(capabilities).size === capabilities.length, "Oprávnění se nesmí opakovat."),
});

export type AgentPermissionPolicy = z.infer<typeof agentPermissionPolicySchema>;

export const AGENT_001_PERMISSION_POLICY: AgentPermissionPolicy = Object.freeze({
  version: 1,
  mode: "simulation",
  capabilities: [...AGENT_CAPABILITIES],
});

export type AgentAuthorizationContext = {
  agent: {
    mode: string;
    status: string;
    killSwitchAt: string | null;
    permissions: unknown;
    maxActionsPerRun: number;
    maxCostMicrounitsPerRun: number;
  };
  run: {
    mode: string;
    status: string;
    actionCount: number;
    costMicrounits: number;
  };
};

export type AgentAuthorizationRequest = {
  capability: AgentCapability;
  costMicrounits: number;
};

export type AgentAuthorizationErrorCode =
  | "AGENT_NOT_ACTIVE"
  | "KILL_SWITCH_ACTIVE"
  | "MODE_NOT_ALLOWED"
  | "RUN_NOT_RUNNING"
  | "INVALID_PERMISSION_POLICY"
  | "CAPABILITY_DENIED"
  | "ACTION_LIMIT_EXCEEDED"
  | "COST_LIMIT_EXCEEDED"
  | "INVALID_REQUEST_COST"
  | "INVALID_RUNTIME_STATE";

export class AgentAuthorizationError extends Error {
  constructor(
    public readonly code: AgentAuthorizationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AgentAuthorizationError";
  }
}

const NON_ACTION_CAPABILITIES = new Set<AgentCapability>(["ledger.append"]);

export function parseAgentPermissionPolicy(value: unknown): AgentPermissionPolicy {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new AgentAuthorizationError("INVALID_PERMISSION_POLICY", "Permission policy není platný JSON.");
    }
  }

  const result = agentPermissionPolicySchema.safeParse(parsed);
  if (!result.success) {
    throw new AgentAuthorizationError("INVALID_PERMISSION_POLICY", "Permission policy neodpovídá podporovanému formátu.");
  }
  return result.data;
}

export function authorizeAgentCapability(
  context: AgentAuthorizationContext,
  request: AgentAuthorizationRequest,
): AgentPermissionPolicy {
  if (context.agent.killSwitchAt !== null) {
    throw new AgentAuthorizationError("KILL_SWITCH_ACTIVE", "Kill switch agenta je aktivní.");
  }
  if (context.agent.status !== "active") {
    throw new AgentAuthorizationError("AGENT_NOT_ACTIVE", "Agent není aktivní.");
  }
  if (context.agent.mode !== "simulation" || context.run.mode !== "simulation") {
    throw new AgentAuthorizationError("MODE_NOT_ALLOWED", "AGENT-001 podporuje pouze simulation režim.");
  }
  if (context.run.status !== "running") {
    throw new AgentAuthorizationError("RUN_NOT_RUNNING", "Operaci lze provést pouze v běžícím runu.");
  }
  if (
    !Number.isSafeInteger(context.agent.maxActionsPerRun)
    || context.agent.maxActionsPerRun < 3
    || context.agent.maxActionsPerRun > 5
    || !Number.isSafeInteger(context.agent.maxCostMicrounitsPerRun)
    || context.agent.maxCostMicrounitsPerRun < 0
    || !Number.isSafeInteger(context.run.actionCount)
    || context.run.actionCount < 0
    || !Number.isSafeInteger(context.run.costMicrounits)
    || context.run.costMicrounits < 0
  ) {
    throw new AgentAuthorizationError("INVALID_RUNTIME_STATE", "Runtime limity agenta nejsou platné.");
  }
  if (!Number.isSafeInteger(request.costMicrounits) || request.costMicrounits < 0) {
    throw new AgentAuthorizationError("INVALID_REQUEST_COST", "Náklad operace musí být nezáporné celé číslo.");
  }

  const policy = parseAgentPermissionPolicy(context.agent.permissions);
  if (policy.mode !== context.agent.mode || !policy.capabilities.includes(request.capability)) {
    throw new AgentAuthorizationError("CAPABILITY_DENIED", `Oprávnění ${request.capability} nebylo uděleno.`);
  }

  if (!NON_ACTION_CAPABILITIES.has(request.capability) && context.run.actionCount + 1 > context.agent.maxActionsPerRun) {
    throw new AgentAuthorizationError("ACTION_LIMIT_EXCEEDED", "Run překročil povolený počet akcí.");
  }
  const projectedCost = context.run.costMicrounits + request.costMicrounits;
  if (!Number.isSafeInteger(projectedCost) || projectedCost > context.agent.maxCostMicrounitsPerRun) {
    throw new AgentAuthorizationError("COST_LIMIT_EXCEEDED", "Run překročil povolený rozpočet.");
  }

  return policy;
}
