import { type AgentEventRuntimePayload, onAgentRuntimeEvent } from "../infra/agent-events.js";

type AgentTurnObserver = (event: AgentEventRuntimePayload) => void;

type OpenClawRuntime = {
  observeAgentTurns(observer: AgentTurnObserver): () => void;
};

export const openClawRuntime: OpenClawRuntime = {
  observeAgentTurns: onAgentRuntimeEvent,
};
