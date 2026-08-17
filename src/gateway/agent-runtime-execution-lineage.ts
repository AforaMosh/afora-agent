import type { AgentRuntimeSessionSpawnContext } from "./agent-runtime-identity-token.js";

type AgentRuntimeExecutionLineage = {
  relation: "sessions_spawn";
  requesterRef: string;
  controllerRef: string;
  depth: number;
  applicableGrantRefs: string[];
  localPolicyRefs: string[];
  runtimeAssuranceRefs: string[];
  targetPolicyRefs: string[];
  externalNativeActions: "observable" | "unsupported";
};

const AGENT_RUNTIME_EXECUTION_LINEAGE = Symbol("agentRuntimeExecutionLineage");

type AgentRuntimeExecutionLineageCarrier = {
  [AGENT_RUNTIME_EXECUTION_LINEAGE]?: AgentRuntimeExecutionLineage;
};

/** Add process-local lineage without expanding or serializing the spawn context. */
export function withAgentRuntimeExecutionLineage<T extends AgentRuntimeSessionSpawnContext>(
  context: T,
  lineage: AgentRuntimeExecutionLineage,
): T & AgentRuntimeExecutionLineageCarrier {
  return { ...context, [AGENT_RUNTIME_EXECUTION_LINEAGE]: lineage };
}

export function readAgentRuntimeExecutionLineage(
  context: (AgentRuntimeSessionSpawnContext & AgentRuntimeExecutionLineageCarrier) | undefined,
): AgentRuntimeExecutionLineage | undefined {
  return context?.[AGENT_RUNTIME_EXECUTION_LINEAGE];
}
