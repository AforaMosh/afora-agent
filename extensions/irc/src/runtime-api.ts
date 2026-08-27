// Private runtime barrel for the bundled IRC extension.
// Keep this barrel thin and generic-only.

export type { BaseProbeResult } from "afora-agent/plugin-sdk/channel-contract";
export type { ChannelPlugin } from "afora-agent/plugin-sdk/channel-core";
export type { AforaConfig } from "afora-agent/plugin-sdk/config-contracts";
export type { PluginRuntime } from "afora-agent/plugin-sdk/runtime-store";
export type { RuntimeEnv } from "afora-agent/plugin-sdk/runtime";
export type {
  BlockStreamingCoalesceConfig,
  DmConfig,
  DmPolicy,
  GroupPolicy,
  GroupToolPolicyBySenderConfig,
  GroupToolPolicyConfig,
  MarkdownConfig,
} from "afora-agent/plugin-sdk/config-contracts";
export type { OutboundReplyPayload } from "afora-agent/plugin-sdk/reply-payload";
export { DEFAULT_ACCOUNT_ID } from "afora-agent/plugin-sdk/account-id";
export { buildChannelConfigSchema } from "afora-agent/plugin-sdk/channel-config-schema";
export {
  PAIRING_APPROVED_MESSAGE,
  buildBaseChannelStatusSummary,
} from "afora-agent/plugin-sdk/channel-status";
export { createChannelPairingController } from "afora-agent/plugin-sdk/channel-pairing";
export { createAccountStatusSink } from "afora-agent/plugin-sdk/channel-outbound";
export { resolveControlCommandGate } from "afora-agent/plugin-sdk/command-auth-native";
export { createChannelMessageReplyPipeline } from "afora-agent/plugin-sdk/channel-outbound";
export { chunkTextForOutbound } from "afora-agent/plugin-sdk/text-chunking";
export {
  deliverFormattedTextWithAttachments,
  formatTextWithAttachmentLinks,
  resolveOutboundMediaUrls,
} from "afora-agent/plugin-sdk/reply-payload";
export {
  GROUP_POLICY_BLOCKED_LABEL,
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce,
} from "afora-agent/plugin-sdk/runtime-group-policy";
export { isDangerousNameMatchingEnabled } from "afora-agent/plugin-sdk/dangerous-name-runtime";
export { logInboundDrop } from "afora-agent/plugin-sdk/channel-inbound";
