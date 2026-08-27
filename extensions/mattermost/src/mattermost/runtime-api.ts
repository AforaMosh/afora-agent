// Mattermost API module exposes the plugin public contract.
export type {
  BaseProbeResult,
  ChannelAccountSnapshot,
  ChannelDirectoryEntry,
  ChatType,
  HistoryEntry,
  AforaConfig,
  AforaPluginApi,
  ReplyPayload,
} from "afora-agent/plugin-sdk/core";
export type { RuntimeEnv } from "afora-agent/plugin-sdk/runtime";
export { resolveAllowlistMatchSimple } from "afora-agent/plugin-sdk/allow-from";
export { logInboundDrop } from "afora-agent/plugin-sdk/channel-inbound";
export { createChannelPairingController } from "afora-agent/plugin-sdk/channel-pairing";
export { createChannelMessageReplyPipeline } from "afora-agent/plugin-sdk/channel-outbound";
export { logTypingFailure } from "afora-agent/plugin-sdk/channel-feedback";
export { listSkillCommandsForAgents } from "afora-agent/plugin-sdk/command-auth-native";
export { buildModelsProviderData } from "afora-agent/plugin-sdk/models-provider-runtime";
export { isDangerousNameMatchingEnabled } from "afora-agent/plugin-sdk/dangerous-name-runtime";
export {
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce,
} from "afora-agent/plugin-sdk/runtime-group-policy";
export { resolveChannelMediaMaxBytes } from "afora-agent/plugin-sdk/media-runtime";
export { loadOutboundMediaFromUrl } from "afora-agent/plugin-sdk/outbound-media";
// Legacy map-helper exports stay for older plugin consumers. New message-turn
// code should use createChannelHistoryWindow.
export {
  DEFAULT_GROUP_HISTORY_LIMIT,
  createChannelHistoryWindow,
} from "afora-agent/plugin-sdk/reply-history";
export { registerPluginHttpRoute } from "afora-agent/plugin-sdk/webhook-targets";
export {
  isRequestBodyLimitError,
  readRequestBodyWithLimit,
} from "afora-agent/plugin-sdk/webhook-ingress";
export { isTrustedProxyAddress, resolveClientIp } from "afora-agent/plugin-sdk/core";
