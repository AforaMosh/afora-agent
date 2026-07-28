/**
 * Reads OpenClaw session history for Codex transcript mirroring and sanitizes
 * image payloads before replaying messages into the app-server projector.
 */
import fs from "node:fs/promises";
import type {
  AgentMessage,
  EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type { SessionEntry } from "openclaw/plugin-sdk/agent-sessions";
import {
  buildSessionContext,
  migrateSessionEntries,
  parseSessionEntries,
} from "openclaw/plugin-sdk/agent-sessions";
import {
  listSessionEntries,
  parseSqliteSessionFileMarker,
  type SqliteSessionFileMarker,
} from "openclaw/plugin-sdk/session-store-runtime";
import { readSessionTranscriptEvents } from "openclaw/plugin-sdk/session-transcript-runtime";
import { sanitizeCodexHistoryImagePayloads } from "./image-payload-sanitizer.js";

function isMissingFileError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

type CodexMirroredSessionHistoryTarget = {
  agentId?: string;
  sessionFile: string;
  sessionId: string;
  sessionKey?: string;
  onExecutionPhase?: EmbeddedRunAttemptParams["onExecutionPhase"];
  purpose?: string;
};

/** Returns sanitized session-context messages for a Codex mirrored session file. */
export async function readCodexMirroredSessionHistoryMessages(
  target: CodexMirroredSessionHistoryTarget,
): Promise<AgentMessage[] | undefined> {
  const backend = parseSqliteSessionFileMarker(target.sessionFile) ? "sqlite" : "jsonl";
  const phaseContext = {
    backend,
    ...(target.purpose ? { purpose: target.purpose } : {}),
  };
  target.onExecutionPhase?.({ phase: "session_materialization_started", ...phaseContext });
  const materializationStartedAt = performance.now();
  let entryCount: number | undefined;
  let messageCount: number | undefined;
  let outcome = "failed";
  try {
    const entries = await readCodexMirroredSessionEntries(target);
    entryCount = entries.length;
    target.onExecutionPhase?.({
      phase: "session_materialization_checkpoint",
      ...phaseContext,
      stage: "entries_loaded",
      entryCount,
      durationMs: performance.now() - materializationStartedAt,
    });
    if (entries.length === 0) {
      outcome = "empty";
      return [];
    }
    const firstEntry = entries[0] as { type?: unknown; id?: unknown } | undefined;
    if (firstEntry?.type !== "session") {
      // A well-formed transcript that does not open with a `session` marker is
      // simply not a Codex-mirrored session (e.g. a non-Codex model run reusing
      // this hook) — an empty mirror, not a read failure, so callers must not
      // warn. `undefined` stays reserved for genuine failures: read/parse errors
      // (caught below) and malformed `session` headers (next check).
      outcome = "foreign_transcript";
      return [];
    }
    if (typeof firstEntry.id !== "string") {
      // A `session` header without a string id is a corrupted Codex transcript,
      // not a foreign one — keep it on the warn path.
      outcome = "malformed_header";
      return undefined;
    }
    migrateSessionEntries(entries);
    const sessionEntries = entries.filter((entry): entry is SessionEntry => {
      return (
        entry !== null &&
        typeof entry === "object" &&
        !Array.isArray(entry) &&
        (entry as { type?: unknown }).type !== "session"
      );
    });
    const messages = buildSessionContext(sessionEntries).messages;
    messageCount = messages.length;
    target.onExecutionPhase?.({
      phase: "session_materialization_checkpoint",
      ...phaseContext,
      stage: "context_built",
      entryCount,
      messageCount,
      durationMs: performance.now() - materializationStartedAt,
    });
    const sanitizedMessages = sanitizeCodexHistoryImagePayloads(messages, "codex mirrored history");
    target.onExecutionPhase?.({
      phase: "session_materialization_checkpoint",
      ...phaseContext,
      stage: "history_sanitized",
      entryCount,
      messageCount,
      durationMs: performance.now() - materializationStartedAt,
    });
    outcome = "materialized";
    return sanitizedMessages;
  } catch (error) {
    // A new Codex session can be read before its transcript exists; other failures still warn.
    if (isMissingFileError(error)) {
      outcome = "missing_file";
      return [];
    }
    return undefined;
  } finally {
    target.onExecutionPhase?.({
      phase: "session_materialized",
      ...phaseContext,
      durationMs: performance.now() - materializationStartedAt,
      outcome,
      entryCount,
      messageCount,
    });
  }
}

async function readCodexMirroredSessionEntries(
  target: CodexMirroredSessionHistoryTarget,
): Promise<SessionEntry[]> {
  const sqliteMarker = parseSqliteSessionFileMarker(target.sessionFile);
  if (sqliteMarker) {
    if (
      sqliteMarker.sessionId !== target.sessionId ||
      (target.agentId !== undefined && sqliteMarker.agentId !== target.agentId)
    ) {
      return [];
    }
    const sessionKey = resolveSqliteMarkerSessionKey(target, sqliteMarker);
    if (!sessionKey) {
      return [];
    }
    return (await readSessionTranscriptEvents({
      agentId: sqliteMarker.agentId,
      sessionId: sqliteMarker.sessionId,
      sessionKey,
      storePath: sqliteMarker.storePath,
    })) as SessionEntry[];
  }
  return parseSessionEntries(await fs.readFile(target.sessionFile, "utf-8")) as SessionEntry[];
}

function resolveSqliteMarkerSessionKey(
  target: CodexMirroredSessionHistoryTarget,
  marker: SqliteSessionFileMarker,
): string | undefined {
  const explicitSessionKey = target.sessionKey?.trim();
  if (explicitSessionKey) {
    return explicitSessionKey;
  }
  const entries = listSessionEntries({
    agentId: marker.agentId,
    readOnly: true,
    storePath: marker.storePath,
  });
  const exactEntry = entries.find(({ entry }) => {
    return entry.sessionId === marker.sessionId && entry.sessionFile === target.sessionFile;
  });
  const sessionEntry =
    exactEntry ??
    entries.find(({ entry }) => {
      return entry.sessionId === marker.sessionId;
    });
  return sessionEntry?.sessionKey;
}
