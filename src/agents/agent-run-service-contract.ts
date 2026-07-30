import type { agentCommandFromIngress } from "./agent-command.js";
import type { AgentCommandIngressOpts } from "./command/types.js";

export type AgentRunResult = Awaited<ReturnType<typeof agentCommandFromIngress>>;

export type AgentRunStart = Omit<
  AgentCommandIngressOpts,
  "abortSignal" | "runId" | "sessionKey" | "to"
> & {
  runId: string;
  sessionKey: string;
  signal?: AbortSignal;
};

type AgentRunHandle = {
  readonly runId: string;
  readonly result: Promise<AgentRunResult>;
  cancel(): boolean;
};

export type AgentRunServiceContract = {
  start(input: AgentRunStart): AgentRunHandle;
  cancel(runId: string): boolean;
};
