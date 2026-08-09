// Slack plugin module implements slash dispatch behavior.
import { isChannelPartialDeliveryError as isChannelPartialDeliveryErrorImpl } from "openclaw/plugin-sdk/channel-inbound";
import { resolveConversationLabel as resolveConversationLabelImpl } from "openclaw/plugin-sdk/conversation-runtime";
import { resolveMarkdownTableMode as resolveMarkdownTableModeImpl } from "openclaw/plugin-sdk/markdown-table-runtime";
import { resolveChunkMode as resolveChunkModeImpl } from "openclaw/plugin-sdk/reply-runtime";
import { resolveAgentRoute as resolveAgentRouteImpl } from "openclaw/plugin-sdk/routing";
import { deliverSlackSlashReplies as deliverSlackSlashRepliesImpl } from "./replies.js";

type ResolveChunkMode = typeof import("openclaw/plugin-sdk/reply-runtime").resolveChunkMode;
type IsChannelPartialDeliveryError =
  typeof import("openclaw/plugin-sdk/channel-inbound").isChannelPartialDeliveryError;
type ResolveConversationLabel =
  typeof import("openclaw/plugin-sdk/conversation-runtime").resolveConversationLabel;
type ResolveMarkdownTableMode =
  typeof import("openclaw/plugin-sdk/markdown-table-runtime").resolveMarkdownTableMode;
type ResolveAgentRoute = typeof import("openclaw/plugin-sdk/routing").resolveAgentRoute;
type DeliverSlackSlashReplies = typeof import("./replies.js").deliverSlackSlashReplies;

export function resolveChunkMode(
  ...args: Parameters<ResolveChunkMode>
): ReturnType<ResolveChunkMode> {
  return resolveChunkModeImpl(...args);
}

export function isChannelPartialDeliveryError(
  ...args: Parameters<IsChannelPartialDeliveryError>
): ReturnType<IsChannelPartialDeliveryError> {
  return isChannelPartialDeliveryErrorImpl(...args);
}

export function resolveConversationLabel(
  ...args: Parameters<ResolveConversationLabel>
): ReturnType<ResolveConversationLabel> {
  return resolveConversationLabelImpl(...args);
}

export function resolveMarkdownTableMode(
  ...args: Parameters<ResolveMarkdownTableMode>
): ReturnType<ResolveMarkdownTableMode> {
  return resolveMarkdownTableModeImpl(...args);
}

export function resolveAgentRoute(
  ...args: Parameters<ResolveAgentRoute>
): ReturnType<ResolveAgentRoute> {
  return resolveAgentRouteImpl(...args);
}

export function deliverSlackSlashReplies(
  ...args: Parameters<DeliverSlackSlashReplies>
): ReturnType<DeliverSlackSlashReplies> {
  return deliverSlackSlashRepliesImpl(...args);
}
