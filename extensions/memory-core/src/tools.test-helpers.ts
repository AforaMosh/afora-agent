import type { AforaPluginToolContext } from "afora-agent/plugin-sdk/plugin-entry";
// Memory Core helper module supports tools helpers behavior.
import { expect } from "vitest";
import type { AforaConfig } from "../api.js";
import { isolateMemoryManagerTestConfig } from "./memory/test-config-helpers.js";
import { createMemoryGetTool, createMemorySearchTool } from "./tools.js";

export function asAforaConfig(config: Partial<AforaConfig>): AforaConfig {
  return isolateMemoryManagerTestConfig(config as AforaConfig);
}

export function createDefaultMemoryToolConfig(): AforaConfig {
  return asAforaConfig({ agents: { list: [{ id: "main", default: true }] } });
}

export function createMemorySearchToolOrThrow(params?: {
  config?: AforaConfig;
  agentId?: string;
  agentSessionKey?: string;
  oneShotCliRun?: boolean;
  conversationRecall?: AforaPluginToolContext["conversationRecall"];
  activeProjectKeys?: readonly string[];
}) {
  const tool = createMemorySearchTool({
    config: params?.config ? asAforaConfig(params.config) : createDefaultMemoryToolConfig(),
    ...(params?.agentId ? { agentId: params.agentId } : {}),
    ...(params?.agentSessionKey ? { agentSessionKey: params.agentSessionKey } : {}),
    ...(params?.oneShotCliRun ? { oneShotCliRun: params.oneShotCliRun } : {}),
    ...(params?.conversationRecall ? { conversationRecall: params.conversationRecall } : {}),
    ...(params?.activeProjectKeys ? { activeProjectKeys: params.activeProjectKeys } : {}),
  });
  if (!tool) {
    throw new Error("tool missing");
  }
  return tool;
}

export function createMemoryGetToolOrThrow(
  config: AforaConfig = createDefaultMemoryToolConfig(),
) {
  const tool = createMemoryGetTool({ config });
  if (!tool) {
    throw new Error("tool missing");
  }
  return tool;
}

export function createAutoCitationsMemorySearchTool(agentSessionKey: string) {
  return createMemorySearchToolOrThrow({
    config: asAforaConfig({
      memory: { citations: "auto" },
      agents: { list: [{ id: "main", default: true }] },
    }),
    agentSessionKey,
  });
}

export function expectUnavailableMemorySearchDetails(
  details: unknown,
  params: {
    error: string;
    warning: string;
    action: string;
  },
) {
  expect(details).toEqual({
    results: [],
    disabled: true,
    unavailable: true,
    error: params.error,
    warning: params.warning,
    action: params.action,
    debug: {
      warning: params.warning,
      action: params.action,
      error: params.error,
    },
  });
}
