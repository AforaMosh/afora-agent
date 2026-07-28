// Memory Core plugin module maps session transcript corpus entries onto
// buildSessionEntry/statSessionEntrySync options.
import type { SessionTranscriptCorpusEntry } from "openclaw/plugin-sdk/memory-core-host-engine-qmd";

/**
 * SQLite-backed corpus entries carry a session store key in `sessionFile`, not a
 * transcript path, so every consumer must forward the agent/session/store identity
 * or `buildSessionEntry` silently falls back to a filesystem read and returns null.
 */
export function buildCorpusSessionEntryOptions(entry: SessionTranscriptCorpusEntry) {
  return {
    generatedByDreamingNarrative: entry.generatedByDreamingNarrative === true,
    generatedByCronRun: entry.generatedByCronRun === true,
    ...(entry.transcriptSource === "sqlite" && entry.storePath
      ? {
          agentId: entry.agentId,
          sessionId: entry.sessionId,
          storePath: entry.storePath,
        }
      : {}),
    ...(entry.sessionKey ? { sessionKey: entry.sessionKey } : {}),
    ...(entry.updatedAtMs !== undefined ? { updatedAtMs: entry.updatedAtMs } : {}),
  };
}
