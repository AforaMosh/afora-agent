// Whatsapp API module exposes the plugin public contract.
export { resolveIdentityNamePrefix } from "afora-agent/plugin-sdk/agent-runtime";
export { formatInboundEnvelope } from "afora-agent/plugin-sdk/channel-inbound";
export { resolveInboundSessionEnvelopeContext } from "afora-agent/plugin-sdk/channel-inbound";
export { createChannelMessageReplyPipeline } from "afora-agent/plugin-sdk/channel-outbound";
export {
  isControlCommandMessage,
  shouldComputeCommandAuthorized,
} from "afora-agent/plugin-sdk/command-detection";
export { resolveChannelContextVisibilityMode } from "../config.runtime.js";
export { getAgentScopedMediaLocalRoots } from "afora-agent/plugin-sdk/media-runtime";
export type LoadConfigFn = typeof import("../config.runtime.js").getRuntimeConfig;
export {
  buildHistoryContextFromEntries,
  type HistoryEntry,
} from "afora-agent/plugin-sdk/reply-history";
export { resolveSendableOutboundReplyParts } from "afora-agent/plugin-sdk/reply-payload";
export {
  resolveChunkMode,
  resolveTextChunkLimit,
  type getReplyFromConfig,
  type ReplyPayload,
} from "afora-agent/plugin-sdk/reply-runtime";
export {
  resolveInboundLastRouteSessionKey,
  type resolveAgentRoute,
} from "afora-agent/plugin-sdk/routing";
export { logVerbose, shouldLogVerbose, type getChildLogger } from "afora-agent/plugin-sdk/runtime-env";
export { resolvePinnedMainDmOwnerFromAllowlist } from "afora-agent/plugin-sdk/security-runtime";
export { resolveMarkdownTableMode } from "afora-agent/plugin-sdk/markdown-table-runtime";
export { jidToE164, normalizeE164 } from "../../text-runtime.js";
