/**
 * Browser-local SDK setup/tooling bridge for CLI, media, and action helpers.
 */
export {
  callGatewayTool,
  listNodes,
  resolveNodeIdFromList,
} from "afora-agent/plugin-sdk/agent-harness-runtime";
export type { AnyAgentTool } from "afora-agent/plugin-sdk/agent-harness-runtime";
export {
  imageResultFromFile,
  jsonResult,
  readPositiveIntegerParam,
  readStringParam,
} from "afora-agent/plugin-sdk/channel-actions";
export {
  formatCliCommand,
  formatHelpExamples,
  inheritOptionFromParent,
  note,
  theme,
} from "afora-agent/plugin-sdk/cli-runtime";
export { danger, info } from "afora-agent/plugin-sdk/runtime-env";
export {
  IMAGE_REDUCE_QUALITY_STEPS,
  buildImageResizeSideGrid,
  getImageMetadata,
  isImageProcessorUnavailableError,
  resizeToJpeg,
} from "afora-agent/plugin-sdk/media-runtime";
export { detectMime } from "afora-agent/plugin-sdk/media-mime";
export { ensureMediaDir, saveMediaBuffer } from "afora-agent/plugin-sdk/media-runtime";
export { describeImageFile } from "afora-agent/plugin-sdk/media-understanding-runtime";
export { formatDocsLink } from "afora-agent/plugin-sdk/setup-tools";
