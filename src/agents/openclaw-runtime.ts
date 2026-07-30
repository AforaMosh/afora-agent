import { type AgentEventRuntimePayload, onAgentRuntimeEvent } from "../infra/agent-events.js";
import type { SessionServiceContract } from "../sessions/session-service-contract.js";
import { SessionService } from "../sessions/session-service.js";
import type { AgentRunServiceContract } from "./agent-run-service-contract.js";
import { AgentRunService } from "./agent-run-service.js";

type AgentTurnObserver = (event: AgentEventRuntimePayload) => void;

type OpenClawRuntime = {
  agentRuns: AgentRunServiceContract;
  observeAgentTurns(observer: AgentTurnObserver): () => void;
  sessions: SessionServiceContract;
};

export const openClawRuntime: OpenClawRuntime = {
  agentRuns: new AgentRunService(),
  observeAgentTurns: onAgentRuntimeEvent,
  sessions: new SessionService(),
};
