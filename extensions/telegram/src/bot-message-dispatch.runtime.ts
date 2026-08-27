// Telegram plugin module implements bot message dispatch behavior.
export { getSessionEntry } from "afora-agent/plugin-sdk/session-store-runtime";
export { resolveMarkdownTableMode } from "afora-agent/plugin-sdk/markdown-table-runtime";
export { getAgentScopedMediaLocalRoots } from "afora-agent/plugin-sdk/media-runtime";
export { resolveChunkMode } from "afora-agent/plugin-sdk/reply-dispatch-runtime";
export {
  generateTelegramTopicLabel as generateTopicLabel,
  resolveAutoTopicLabelConfig,
} from "./auto-topic-label.js";
