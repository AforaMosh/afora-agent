// Agent-facing runtime facade for memory host packages.
// Keep exports here limited to config/state helpers that memory plugins may reuse.
export {
  DEFAULT_AGENT_COMPACTION_RESERVE_TOKENS_FLOOR,
  asToolParamsRecord,
  jsonResult,
  parseAgentSessionKey,
  readNumberParam,
  readStringParam,
  resolveAgentContextLimits,
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveCronStyleNow,
  resolveDefaultAgentId,
  resolveMemorySearchConfig,
  resolveMemorySearchSyncConfig,
  resolveSessionAgentId,
} from "./afora-runtime.js";
export type {
  AnyAgentTool,
  ResolvedMemorySearchConfig,
  ResolvedMemorySearchSyncConfig,
} from "./afora-runtime.js";
