// Telegram plugin module implements send behavior.
export { requireRuntimeConfig } from "afora-agent/plugin-sdk/plugin-config-runtime";
export { resolveMarkdownTableMode } from "afora-agent/plugin-sdk/markdown-table-runtime";
export type { AforaConfig } from "afora-agent/plugin-sdk/config-contracts";
export type { PollInput } from "afora-agent/plugin-sdk/media-runtime";
export {
  buildOutboundMediaLoadOptions,
  getImageMetadata,
  normalizePollInput,
  probeVideoDimensions,
} from "afora-agent/plugin-sdk/media-runtime";
export { loadWebMedia } from "afora-agent/plugin-sdk/web-media";
