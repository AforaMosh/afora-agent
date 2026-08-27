// Narrow Matrix monitor helper seam.
// Keep monitor internals off the broad package runtime-api barrel so monitor
// tests and shared workers do not pull unrelated Matrix helper surfaces.

export type { NormalizedLocation } from "afora-agent/plugin-sdk/channel-inbound";
export type { PluginRuntime, RuntimeLogger } from "afora-agent/plugin-sdk/plugin-runtime";
export type { BlockReplyContext, ReplyPayload } from "afora-agent/plugin-sdk/reply-runtime";
export type { MarkdownTableMode, AforaConfig } from "afora-agent/plugin-sdk/config-contracts";
export type { RuntimeEnv } from "afora-agent/plugin-sdk/runtime";
export {
  addAllowlistUserEntriesFromConfigEntry,
  buildAllowlistResolutionSummary,
  canonicalizeAllowlistWithResolvedIds,
  patchAllowlistUsersInConfigEntries,
  summarizeMapping,
} from "afora-agent/plugin-sdk/allow-from";
export {
  createReplyPrefixOptions,
  createTypingCallbacks,
} from "afora-agent/plugin-sdk/channel-outbound";
export { formatLocationText, toLocationContext } from "afora-agent/plugin-sdk/channel-inbound";
export { getAgentScopedMediaLocalRoots } from "afora-agent/plugin-sdk/media-local-roots";
export { logInboundDrop } from "afora-agent/plugin-sdk/channel-inbound";
export { logTypingFailure } from "afora-agent/plugin-sdk/channel-outbound";
export { buildChannelKeyCandidates } from "afora-agent/plugin-sdk/channel-targets";
