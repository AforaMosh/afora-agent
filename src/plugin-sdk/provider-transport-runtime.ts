/**
 * Runtime SDK subpath for provider transport helpers and stream primitives.
 */
export { buildGuardedModelFetch } from "../agents/provider-transport-fetch.js";
export { buildOpenAICompletionsParams } from "../agents/openai-transport-stream.js";
export {
  sortPromptCacheToolsByName,
  stripSystemPromptCacheBoundary,
} from "@afora/ai/internal/shared";
export { transformTransportMessages } from "../agents/transport-message-transform.js";
export {
  describeToolResultMediaPlaceholder,
  extractToolResultText,
} from "@afora/ai/internal/shared";
export {
  coerceTransportToolCallArguments,
  createEmptyTransportUsage,
  createWritableTransportEventStream,
  failTransportStream,
  finalizeTransportStream,
  mergeTransportHeaders,
  sanitizeTransportPayloadText,
  type WritableTransportStream,
} from "@afora/ai/transports";
