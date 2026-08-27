// Telegram helper module supports agent config behavior.
import { resolveAgentConfig } from "afora-agent/plugin-sdk/agent-scope-runtime";
import type { AforaConfig } from "afora-agent/plugin-sdk/config-contracts";

type ReasoningDefault = "on" | "stream" | "off";

export function resolveTelegramConfigReasoningDefault(
  cfg: AforaConfig,
  agentId: string,
): ReasoningDefault {
  const agentDefault = resolveAgentConfig(cfg, agentId)?.reasoningDefault;
  return agentDefault ?? cfg.agents?.defaults?.reasoningDefault ?? "off";
}
