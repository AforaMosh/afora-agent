// Private runtime barrel for the bundled Mattermost extension.
// Keep this barrel thin and generic-only.

export type {
  BaseProbeResult,
  ChannelAccountSnapshot,
  ChannelDirectoryEntry,
  ChannelGroupContext,
  ChannelMessageActionName,
  ChannelPlugin,
  ChatType,
  HistoryEntry,
  AforaConfig,
  AforaPluginApi,
  PluginRuntime,
} from "afora-agent/plugin-sdk/core";
export type { RuntimeEnv } from "afora-agent/plugin-sdk/runtime";
export type { ReplyPayload } from "afora-agent/plugin-sdk/reply-runtime";
export type { ModelsProviderData } from "afora-agent/plugin-sdk/models-provider-runtime";
export type {
  BlockStreamingCoalesceConfig,
  DmPolicy,
  GroupPolicy,
} from "afora-agent/plugin-sdk/config-contracts";
export {
  DEFAULT_ACCOUNT_ID,
  buildChannelConfigSchema,
  createDedupeCache,
  parseStrictPositiveInteger,
  resolveClientIp,
  isTrustedProxyAddress,
} from "afora-agent/plugin-sdk/core";
export { buildComputedAccountStatusSnapshot } from "afora-agent/plugin-sdk/channel-status";
export { createAccountStatusSink } from "afora-agent/plugin-sdk/channel-outbound";
export {
  listSkillCommandsForAgents,
  resolveControlCommandGate,
  resolveStoredModelOverride,
} from "afora-agent/plugin-sdk/command-auth-native";
export { buildModelsProviderData } from "afora-agent/plugin-sdk/models-provider-runtime";
export {
  GROUP_POLICY_BLOCKED_LABEL,
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce,
} from "afora-agent/plugin-sdk/runtime-group-policy";
export { isDangerousNameMatchingEnabled } from "afora-agent/plugin-sdk/dangerous-name-runtime";
export { resolveStorePath } from "afora-agent/plugin-sdk/session-store-runtime";
export { formatInboundFromLabel } from "afora-agent/plugin-sdk/channel-inbound";
export { logInboundDrop } from "afora-agent/plugin-sdk/channel-inbound";
export { createChannelPairingController } from "afora-agent/plugin-sdk/channel-pairing";
export { createChannelMessageReplyPipeline } from "afora-agent/plugin-sdk/channel-outbound";
export { logTypingFailure } from "afora-agent/plugin-sdk/channel-feedback";
export { loadOutboundMediaFromUrl } from "afora-agent/plugin-sdk/outbound-media";
export { rawDataToString } from "afora-agent/plugin-sdk/webhook-ingress";
export { chunkTextForOutbound } from "afora-agent/plugin-sdk/text-chunking";
// Legacy map-helper exports stay for older plugin consumers. New message-turn
// code should use createChannelHistoryWindow.
export {
  DEFAULT_GROUP_HISTORY_LIMIT,
  createChannelHistoryWindow,
  buildPendingHistoryContextFromMap,
  clearHistoryEntriesIfEnabled,
  recordPendingHistoryEntryIfEnabled,
} from "afora-agent/plugin-sdk/reply-history";
export { normalizeAccountId, resolveThreadSessionKeys } from "afora-agent/plugin-sdk/routing";
export { resolveAllowlistMatchSimple } from "afora-agent/plugin-sdk/allow-from";
export { registerPluginHttpRoute } from "afora-agent/plugin-sdk/webhook-targets";
export {
  isRequestBodyLimitError,
  readRequestBodyWithLimit,
} from "afora-agent/plugin-sdk/webhook-ingress";
export {
  applyAccountNameToChannelSection,
  applySetupAccountConfigPatch,
  migrateBaseNameToDefaultAccount,
} from "afora-agent/plugin-sdk/setup";
export {
  getAgentScopedMediaLocalRoots,
  resolveChannelMediaMaxBytes,
} from "afora-agent/plugin-sdk/media-runtime";
export { normalizeProviderId } from "afora-agent/plugin-sdk/provider-model-shared";
export { setMattermostRuntime } from "./src/runtime.js";
