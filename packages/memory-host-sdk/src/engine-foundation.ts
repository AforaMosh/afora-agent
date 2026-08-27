// Real workspace contract for memory engine foundation concerns.

export {
  resolveAgentContextLimits,
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
  resolveSessionAgentId,
} from "./host/afora-runtime-agent.js";
export {
  resolveMemorySearchConfig,
  resolveMemorySearchSyncConfig,
  type ResolvedMemorySearchConfig,
  type ResolvedMemorySearchSyncConfig,
} from "./host/afora-runtime-agent.js";
export { parseDurationMs } from "./host/afora-runtime-config.js";
export { loadConfig } from "./host/afora-runtime-config.js";
export { resolveStateDir } from "./host/afora-runtime-config.js";
export { resolveSessionTranscriptsDirForAgent } from "./host/afora-runtime-config.js";
export {
  hasConfiguredSecretInput,
  normalizeResolvedSecretInputString,
} from "./host/afora-runtime-config.js";
export { root } from "./host/afora-runtime-io.js";
export { isPathInside } from "./host/fs-utils.js";
export { createSubsystemLogger } from "./host/afora-runtime-io.js";
export { detectMime } from "./host/afora-runtime-io.js";
export { resolveGlobalSingleton } from "./host/afora-runtime-io.js";
export { onSessionTranscriptUpdate } from "./host/afora-runtime-session.js";
export { splitShellArgs } from "./host/afora-runtime-io.js";
export { runTasksWithConcurrency } from "./host/afora-runtime-io.js";
export {
  shortenHomeInString,
  shortenHomePath,
  resolveUserPath,
  truncateUtf16Safe,
} from "./host/afora-runtime-io.js";
export type { AforaConfig } from "./host/afora-runtime-config.js";
export type { SecretInput } from "./host/afora-runtime-config.js";
export type { MemoryCitationsMode } from "./host/afora-runtime-config.js";
export type { MemorySearchConfig } from "./host/afora-runtime-config.js";
