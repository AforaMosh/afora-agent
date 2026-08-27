// Telegram plugin module implements bot message context.session behavior.
export { buildChannelInboundEventContext } from "afora-agent/plugin-sdk/channel-inbound";
export {
  readAmbientTranscriptWatermark,
  readSessionUpdatedAt,
  resolveAmbientTranscriptWatermarkKey,
  resolveStorePath,
} from "afora-agent/plugin-sdk/session-store-runtime";
export { recordInboundSession } from "afora-agent/plugin-sdk/conversation-runtime";
export { resolveInboundLastRouteSessionKey } from "afora-agent/plugin-sdk/routing";
export { resolvePinnedMainDmOwnerFromAllowlist } from "afora-agent/plugin-sdk/security-runtime";
