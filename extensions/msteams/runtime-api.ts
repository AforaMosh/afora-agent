// Private runtime barrel for the bundled Microsoft Teams extension.
// Keep this barrel thin and aligned with the local extension surface.

export { DEFAULT_ACCOUNT_ID } from "afora-agent/plugin-sdk/account-id";
export type { AllowlistMatch } from "afora-agent/plugin-sdk/allow-from";
export {
  mergeAllowlist,
  resolveAllowlistMatchSimple,
  summarizeMapping,
} from "afora-agent/plugin-sdk/allow-from";
export type {
  BaseProbeResult,
  ChannelDirectoryEntry,
  ChannelGroupContext,
  ChannelMessageActionName,
  ChannelOutboundAdapter,
} from "afora-agent/plugin-sdk/channel-contract";
export type { ChannelPlugin } from "afora-agent/plugin-sdk/channel-core";
export { logTypingFailure } from "afora-agent/plugin-sdk/channel-outbound";
export { createChannelPairingController } from "afora-agent/plugin-sdk/channel-pairing";
export { resolveToolsBySender } from "afora-agent/plugin-sdk/channel-policy";
export { createChannelMessageReplyPipeline } from "afora-agent/plugin-sdk/channel-outbound";
export {
  PAIRING_APPROVED_MESSAGE,
  buildProbeChannelStatusSummary,
  createDefaultChannelRuntimeState,
} from "afora-agent/plugin-sdk/channel-status";
export {
  buildChannelKeyCandidates,
  normalizeChannelSlug,
  resolveChannelEntryMatchWithFallback,
  resolveNestedAllowlistDecision,
} from "afora-agent/plugin-sdk/channel-targets";
export type {
  GroupPolicy,
  GroupToolPolicyConfig,
  MSTeamsChannelConfig,
  MSTeamsCloudName,
  MSTeamsConfig,
  MSTeamsReplyStyle,
  MSTeamsTeamConfig,
  MarkdownTableMode,
  AforaConfig,
} from "afora-agent/plugin-sdk/config-contracts";
export { isDangerousNameMatchingEnabled } from "afora-agent/plugin-sdk/dangerous-name-runtime";
export { resolveDefaultGroupPolicy } from "afora-agent/plugin-sdk/runtime-group-policy";
export { withFileLock } from "afora-agent/plugin-sdk/file-lock";
export { keepHttpServerTaskAlive } from "afora-agent/plugin-sdk/channel-outbound";
export {
  detectMime,
  extensionForMime,
  extractOriginalFilename,
  getFileExtension,
  resolveChannelMediaMaxBytes,
} from "afora-agent/plugin-sdk/media-runtime";
export { loadOutboundMediaFromUrl } from "afora-agent/plugin-sdk/outbound-media";
// Deprecated media-legacy-projection surface; the re-export stays until the
// compat record's removeAfter window expires (deleted in retirement PR 4).
export { buildMediaPayload } from "afora-agent/plugin-sdk/reply-payload";
export type { ReplyPayload } from "afora-agent/plugin-sdk/reply-payload";
export type { PluginRuntime } from "afora-agent/plugin-sdk/runtime-store";
export type { RuntimeEnv } from "afora-agent/plugin-sdk/runtime";
export type { SsrFPolicy } from "afora-agent/plugin-sdk/ssrf-runtime";
export { fetchWithSsrFGuard } from "afora-agent/plugin-sdk/ssrf-runtime";
export { normalizeStringEntries } from "afora-agent/plugin-sdk/string-normalization-runtime";
export { chunkTextForOutbound } from "afora-agent/plugin-sdk/text-chunking";
export { DEFAULT_WEBHOOK_MAX_BODY_BYTES } from "afora-agent/plugin-sdk/webhook-ingress";
export { setMSTeamsRuntime } from "./src/runtime.js";
