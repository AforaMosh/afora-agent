import type { AgentConfig, AforaConfig } from "../config/config.js";
import { normalizeAgentId } from "../routing/session-key.js";
import type { PersistedClawInstall } from "./provenance.js";
import type { ClawAddPlan } from "./types.js";

export function replaceLegacyCommittedAgent(params: {
  config: AforaConfig;
  agents: AgentConfig[];
  normalizedAgentId: string;
  plan: ClawAddPlan;
  resumePlan?: ClawAddPlan;
  resumeRecord?: PersistedClawInstall;
  matchesPlan: (agent: AgentConfig, plan: ClawAddPlan) => boolean;
}): AforaConfig | undefined {
  if (
    !params.resumePlan ||
    params.resumeRecord?.schemaVersion !== "afora.clawInstallRecord.v1" ||
    params.resumeRecord.status === "complete"
  ) {
    return undefined;
  }
  const existingAgent = params.agents.find(
    (agent) => normalizeAgentId(agent.id) === params.normalizedAgentId,
  );
  if (!existingAgent || !params.matchesPlan(existingAgent, params.resumePlan)) {
    return undefined;
  }
  return {
    ...params.config,
    agents: {
      ...params.config.agents,
      entries: Object.fromEntries(
        params.agents.map((agent) => {
          const replacement =
            normalizeAgentId(agent.id) === params.normalizedAgentId
              ? params.plan.agent.config
              : agent;
          const { id, ...entry } = replacement;
          return [id, entry];
        }),
      ),
    },
  };
}
