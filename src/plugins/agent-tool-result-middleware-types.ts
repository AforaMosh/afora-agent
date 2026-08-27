// Defines plugin middleware contracts for agent tool results.
import type { AgentToolResult } from "../agents/runtime/index.js";
import type { PluginToolMatcher } from "./hook-types.js";

export type AforaAgentToolResult<TResult = unknown> = AgentToolResult<TResult>;

export type AgentToolResultMiddlewareRuntime = "afora" | "codex";

export type AgentToolResultMiddlewareEvent = {
  threadId?: string;
  turnId?: string;
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  cwd?: string;
  isError?: boolean;
  result: AforaAgentToolResult;
};

export type AgentToolResultMiddlewareContext = {
  runtime: AgentToolResultMiddlewareRuntime;
  agentId?: string;
  sessionId?: string;
  sessionKey?: string;
  runId?: string;
};

export type AgentToolResultMiddlewareResult = {
  result: AforaAgentToolResult;
};

export type AgentToolResultMiddleware = (
  event: AgentToolResultMiddlewareEvent,
  ctx: AgentToolResultMiddlewareContext,
) => Promise<AgentToolResultMiddlewareResult | void> | AgentToolResultMiddlewareResult | void;

export type AgentToolResultMiddlewareOptions = {
  matcher?: PluginToolMatcher;
  runtimes?: AgentToolResultMiddlewareRuntime[];
};

export type AgentToolResultMiddlewareScope = {
  matcher?: PluginToolMatcher;
  runtimes: AgentToolResultMiddlewareRuntime[];
};
