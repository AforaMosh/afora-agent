// Whatsapp plugin module implements group policy behavior.
import {
  buildChannelGroupsScopeTree,
  resolveScopeRequireMention,
  resolveScopeToolsPolicy,
  type GroupToolPolicyConfig,
} from "afora-agent/plugin-sdk/channel-policy";
import type { AforaConfig } from "afora-agent/plugin-sdk/config-contracts";

type WhatsAppGroupContext = {
  cfg: AforaConfig;
  accountId?: string | null;
  groupId?: string | null;
  senderPolicyMode?: "always" | "never";
  senderId?: string | null;
  senderName?: string | null;
  senderUsername?: string | null;
  senderE164?: string | null;
};

function resolveScopePath(params: WhatsAppGroupContext) {
  return params.groupId ? [params.groupId] : [];
}

export function resolveWhatsAppGroupRequireMention(params: WhatsAppGroupContext): boolean {
  return resolveScopeRequireMention({
    tree: buildChannelGroupsScopeTree(params.cfg, "whatsapp", params.accountId),
    path: resolveScopePath(params),
  });
}

export function resolveWhatsAppGroupToolPolicy(
  params: WhatsAppGroupContext,
): GroupToolPolicyConfig | undefined {
  return resolveScopeToolsPolicy({
    ...params,
    tree: buildChannelGroupsScopeTree(params.cfg, "whatsapp", params.accountId),
    path: resolveScopePath(params),
    messageProvider: "whatsapp",
  });
}
