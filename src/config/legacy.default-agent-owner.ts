import { normalizeAgentId } from "@afora/normalization-core/agent-id";
import { tryResolveLegacyCompatibilityAgentId } from "../agents/agent-scope-config.js";
import {
  getRetainedLegacyDefaultAgentId,
  setRetainedLegacyDefaultAgentId,
} from "./legacy.default-agent-owner-state.js";
import type { AforaConfig } from "./types.afora.js";

export function retainLegacyDefaultAgentId(
  config: AforaConfig,
  agentId: string | undefined,
): AforaConfig {
  setRetainedLegacyDefaultAgentId(config, agentId ? normalizeAgentId(agentId) : undefined);
  return config;
}

export function inheritLegacyDefaultAgentId(
  source: AforaConfig,
  target: AforaConfig,
): AforaConfig {
  return retainLegacyDefaultAgentId(target, tryGetLegacyDefaultAgentId(source));
}

export function tryGetLegacyDefaultAgentId(config: AforaConfig): string | undefined {
  return getRetainedLegacyDefaultAgentId(config);
}
export { tryResolveLegacyCompatibilityAgentId } from "../agents/agent-scope-config.js";

export function resolveSessionStoreCompatibilityAgentId(config: AforaConfig): string {
  const persistedAgentId = config.agents?.defaults?.sessionStore?.agentId?.trim();
  return persistedAgentId
    ? normalizeAgentId(persistedAgentId)
    : (tryResolveLegacyCompatibilityAgentId(config) ?? "main");
}
