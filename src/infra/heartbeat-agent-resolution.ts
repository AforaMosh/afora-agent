import { normalizeOptionalString } from "@afora/normalization-core/string-coerce";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { tryResolveLegacyCompatibilityAgentId } from "../config/legacy.default-agent-owner.js";
import type { AforaConfig } from "../config/types.afora.js";
import { normalizeAgentId } from "../routing/session-key.js";

export function resolveAmbientHeartbeatAgentId(cfg: AforaConfig): string {
  return normalizeAgentId(
    normalizeOptionalString(cfg.agents?.defaults?.heartbeat?.agentId) ??
      tryResolveLegacyCompatibilityAgentId(cfg) ??
      resolveDefaultAgentId(cfg, {
        surface: "ambient heartbeat scheduling",
        hint: "Set agents.defaults.heartbeat.agentId to the agent that owns ambient heartbeats.",
      }),
  );
}
