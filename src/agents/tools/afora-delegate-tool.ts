/** Thin regular-agent client for the Afora system agent. */
import { createHash, randomUUID } from "node:crypto";
import { Type } from "typebox";
import { SYSTEM_AGENT_ID } from "../../system-agent/agent-id.js";
import { jsonResult, readToolStringParam, type AnyAgentTool } from "./common.js";
import { callInProcessGatewayTool, type InProcessGatewayCaller } from "./in-process-gateway.js";

const AforaDelegateSchema = Type.Object({
  message: Type.String({ description: "What system must do." }),
  sessionId: Type.Optional(Type.String({ description: "Continue prior Afora talk." })),
});

const AforaDelegateOutputSchema = Type.Object(
  {
    reply: Type.String(),
    action: Type.Optional(Type.String()),
    needsApproval: Type.Optional(Type.Literal(true)),
    proposalId: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

type AforaDelegateResult = {
  sessionId: string;
  reply: string;
  action?: string;
  needsApproval?: boolean;
  proposalId?: string;
};

function stableDelegationSessionId(sessionKey: string | undefined, agentId?: string): string {
  return sessionKey?.trim()
    ? `delegate-${createHash("sha256")
        .update(`${agentId?.trim() ?? "unknown"}\0${sessionKey.trim()}`)
        .digest("hex")
        .slice(0, 32)}`
    : `delegate-${randomUUID()}`;
}

function createAforaDelegateTool(options?: {
  requesterAgentId?: string;
  agentSessionKey?: string;
  turnSourceChannel?: string;
  turnSourceTo?: string;
  turnSourceAccountId?: string;
  turnSourceThreadId?: string | number;
  callGateway?: InProcessGatewayCaller;
}): AnyAgentTool {
  const defaultSessionId = stableDelegationSessionId(
    options?.agentSessionKey,
    options?.requesterAgentId,
  );
  return {
    name: "afora",
    label: "Afora",
    description:
      "Ask system expert. Gateway restart, config, channels, plugins, agents, models/providers, updates. Changes need human approval.",
    parameters: AforaDelegateSchema,
    outputSchema: AforaDelegateOutputSchema,
    execute: async (_toolCallId, args) => {
      const params = (args ?? {}) as Record<string, unknown>;
      const message = readToolStringParam(params, "message", { required: true });
      const sessionId = readToolStringParam(params, "sessionId") ?? defaultSessionId;
      const callGateway = options?.callGateway ?? callInProcessGatewayTool;
      const result = await callGateway<AforaDelegateResult>("afora.chat", {
        sessionId,
        message,
        delegation: {
          ...(options?.requesterAgentId ? { agentId: options.requesterAgentId } : {}),
          ...(options?.agentSessionKey ? { sessionKey: options.agentSessionKey } : {}),
          ...(options?.turnSourceChannel ? { turnSourceChannel: options.turnSourceChannel } : {}),
          ...(options?.turnSourceTo ? { turnSourceTo: options.turnSourceTo } : {}),
          ...(options?.turnSourceAccountId
            ? { turnSourceAccountId: options.turnSourceAccountId }
            : {}),
          ...(options?.turnSourceThreadId !== undefined
            ? { turnSourceThreadId: options.turnSourceThreadId }
            : {}),
        },
      });
      return jsonResult({
        reply: result.reply,
        ...(result.action && result.action !== "none" ? { action: result.action } : {}),
        ...(result.needsApproval ? { needsApproval: true } : {}),
        ...(result.proposalId ? { proposalId: result.proposalId } : {}),
      });
    },
  };
}

export function createAforaDelegateToolsForRun(options: {
  sessionAgentId: string;
  sandboxed?: boolean;
  runSessionKey?: string;
  agentSessionKey?: string;
  agentChannel?: string;
  currentMessagingTarget?: string;
  currentChannelId?: string;
  agentTo?: string;
  agentAccountId?: string;
  currentThreadTs?: string;
  agentThreadId?: string | number;
}): AnyAgentTool[] {
  if (options.sandboxed || options.sessionAgentId === SYSTEM_AGENT_ID) {
    return [];
  }
  return [
    createAforaDelegateTool({
      requesterAgentId: options.sessionAgentId,
      agentSessionKey: options.runSessionKey ?? options.agentSessionKey,
      turnSourceChannel: options.agentChannel,
      turnSourceTo: options.currentMessagingTarget ?? options.currentChannelId ?? options.agentTo,
      turnSourceAccountId: options.agentAccountId,
      turnSourceThreadId: options.currentThreadTs ?? options.agentThreadId,
    }),
  ];
}
