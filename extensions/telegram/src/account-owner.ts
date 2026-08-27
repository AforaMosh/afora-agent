import type { AforaConfig } from "afora-agent/plugin-sdk/config-contracts";
import { resolveAgentRoute } from "afora-agent/plugin-sdk/routing";

/** Resolves the agent that owns account-scoped Telegram runtime state. */
export function resolveTelegramAccountOwnerAgentId(params: {
  cfg: AforaConfig;
  accountId?: string | null;
}): string {
  return resolveAgentRoute({
    cfg: params.cfg,
    channel: "telegram",
    accountId: params.accountId,
  }).agentId;
}
