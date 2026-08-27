// Whatsapp plugin module implements message line behavior.
import { resolveAgentConfig } from "afora-agent/plugin-sdk/agent-scope-runtime";
import type { AforaConfig } from "afora-agent/plugin-sdk/config-contracts";

export {
  formatInboundEnvelope,
  type EnvelopeFormatOptions,
} from "afora-agent/plugin-sdk/channel-inbound";

type WhatsAppMessagePrefixConfig = AforaConfig;

function resolveIdentityNamePrefix(
  cfg: WhatsAppMessagePrefixConfig,
  agentId: string,
): string | undefined {
  const identityName = resolveAgentConfig(cfg, agentId)?.identity?.name?.trim();
  return identityName ? `[${identityName}]` : undefined;
}

export function resolveMessagePrefix(
  cfg: WhatsAppMessagePrefixConfig,
  agentId: string,
  opts?: { configured?: string; hasAllowFrom?: boolean; fallback?: string },
): string {
  const configured = opts?.configured;
  if (configured !== undefined) {
    return configured;
  }
  if (opts?.hasAllowFrom === true) {
    return "";
  }
  return resolveIdentityNamePrefix(cfg, agentId) ?? opts?.fallback ?? "[afora]";
}
