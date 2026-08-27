// Focused runtime contract for memory plugin config/state/helpers.

export type { AnyAgentTool } from "./host/afora-runtime-agent.js";
export { resolveCronStyleNow } from "./host/afora-runtime-agent.js";
export { DEFAULT_AGENT_COMPACTION_RESERVE_TOKENS_FLOOR } from "./host/afora-runtime-agent.js";
export { resolveDefaultAgentId, resolveSessionAgentId } from "./host/afora-runtime-agent.js";
export { resolveMemorySearchConfig } from "./host/afora-runtime-agent.js";
export {
  asToolParamsRecord,
  jsonResult,
  readNumberParam,
  readStringParam,
} from "./host/afora-runtime-agent.js";
export { SILENT_REPLY_TOKEN } from "./host/afora-runtime-session.js";
export { parseNonNegativeByteSize } from "./host/afora-runtime-config.js";
export {
  getRuntimeConfig,
  /** @deprecated Use getRuntimeConfig(), or pass the already loaded config through the call path. */
  loadConfig,
} from "./host/afora-runtime-config.js";
export { resolveStateDir } from "./host/afora-runtime-config.js";
export { resolveSessionTranscriptsDirForAgent } from "./host/afora-runtime-config.js";
export { emptyPluginConfigSchema } from "./host/afora-runtime-memory.js";
export {
  buildActiveMemoryPromptSection,
  getMemoryCapabilityRegistration,
  listActiveMemoryPublicArtifacts,
} from "./host/afora-runtime-memory.js";
export { parseAgentSessionKey } from "./host/afora-runtime-agent.js";
export type { AforaConfig } from "./host/afora-runtime-config.js";
export type { MemoryCitationsMode } from "./host/afora-runtime-config.js";
export type {
  MemoryFlushPlan,
  MemoryFlushPlanResolver,
  MemoryPluginCapability,
  MemoryPluginPublicArtifact,
  MemoryPluginPublicArtifactsProvider,
  MemoryPluginRuntime,
  MemoryPromptSectionBuilder,
} from "./host/afora-runtime-memory.js";
export type { AforaPluginApi } from "./host/afora-runtime-memory.js";
