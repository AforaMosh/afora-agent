import { type AgentEventRuntimePayload, onAgentRuntimeEvent } from "../infra/agent-events.js";
import type { SessionServiceContract } from "../sessions/session-service-contract.js";
import { SessionService } from "../sessions/session-service.js";

type AgentTurnObserver = (event: AgentEventRuntimePayload) => void;

type OpenClawRuntime = {
  observeAgentTurns(observer: AgentTurnObserver): () => void;
  sessions: SessionServiceContract;
};

export const openClawRuntime: OpenClawRuntime = {
  observeAgentTurns: onAgentRuntimeEvent,
  sessions: new SessionService(),
};
