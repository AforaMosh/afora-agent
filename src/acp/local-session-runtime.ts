/** Process-local ACP access to canonical OpenClaw session and transcript storage. */
import { randomUUID } from "node:crypto";
import type { SessionInfo } from "@agentclientprotocol/sdk";
import {
  toAcpSessionLineageMeta,
  type AcpSessionLineageRow,
} from "@openclaw/acp-core/session-lineage-meta";
import type { AcpServerOptions } from "@openclaw/acp-core/types";
import { timestampMsToIsoString } from "@openclaw/normalization-core/number-coercion";
import {
  normalizeFastMode,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import {
  normalizeElevatedLevel,
  normalizeReasoningLevel,
  normalizeThinkLevel,
  normalizeUsageDisplay,
} from "../auto-reply/thinking.shared.js";
import { getRuntimeConfig } from "../config/config.js";
import { loadCombinedSessionStore } from "../config/sessions/combined-store.js";
import {
  readRecentSessionTranscriptMessageEvents,
  readSessionTranscriptMessageEventCount,
  readSessionTranscriptMessageEventPage,
  patchSessionEntryTarget,
  resetSessionEntryLifecycle,
} from "../config/sessions/session-accessor.js";
import { loadResolvedSessionEntryReadOnly } from "../config/sessions/session-entry-loader.js";
import { buildSessionResetEntry } from "../config/sessions/session-reset-entry.js";
import {
  resolveSessionStoreAgentId,
  resolveSessionStoreKey,
} from "../config/sessions/session-store-key.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { classifySessionKind } from "../sessions/classify-session-kind.js";
import { hasInterSessionUserProvenance } from "../sessions/input-provenance.js";
import {
  applyTraceOverride,
  applyVerboseOverride,
  parseTraceOverride,
  parseVerboseOverride,
} from "../sessions/level-overrides.js";
import { parseSessionLabel } from "../sessions/session-label.js";
import { deriveSessionTitle } from "../sessions/session-title.js";
import type { AcpSessionMeta } from "./session-mapper.js";
import {
  buildSessionMetadata,
  buildSessionPresentation,
  buildSessionUsageSnapshot,
  type AcpSessionPresentationRow,
  type SessionSnapshot,
} from "./translator.presentation.js";

const ACP_SESSION_TRANSCRIPT_LIMIT = 200;
const ACP_SESSION_TRANSCRIPT_MAX_BYTES = 8 * 1024 * 1024;

export type { SessionSnapshot } from "./translator.presentation.js";

/** Storage-neutral transcript message shape consumed by ACP replay. */
type AcpSessionTranscriptMessage = {
  role?: unknown;
  content?: unknown;
};

/** Session row fields used by ACP presentation and list responses. */
export type AcpLocalSessionPresentationRow = AcpSessionLineageRow & AcpSessionPresentationRow;

/** Durable ACP-visible session fields supported by the local session domain. */
export type AcpLocalSessionPatch = {
  thinkingLevel?: string | null;
  fastMode?: SessionEntry["fastMode"] | null;
  verboseLevel?: string | null;
  traceLevel?: string | null;
  reasoningLevel?: string | null;
  responseUsage?: SessionEntry["responseUsage"] | null;
  elevatedLevel?: string | null;
};

type LoadedSessionRecord = ReturnType<typeof loadResolvedSessionEntryReadOnly>;
type CombinedSessionStore = ReturnType<typeof loadCombinedSessionStore>;

export type AcpLocalSessionRuntimeDeps = {
  getConfig: () => OpenClawConfig;
  loadCombinedStore: (cfg: OpenClawConfig) => CombinedSessionStore;
  loadSession: (sessionKey: string) => LoadedSessionRecord;
  patchEntry: typeof patchSessionEntryTarget;
  readTranscriptEvents: typeof readRecentSessionTranscriptMessageEvents;
  readTranscriptMessageCount: typeof readSessionTranscriptMessageEventCount;
  readTranscriptPage: typeof readSessionTranscriptMessageEventPage;
  resetSession: typeof resetSessionEntryLifecycle;
  createId: () => string;
  now: () => number;
};

export type AcpLocalSessionRuntime = {
  resolveSessionKey: (params: { meta: AcpSessionMeta; fallbackKey: string }) => Promise<string>;
  resetSessionIfNeeded: (params: {
    meta: AcpSessionMeta;
    sessionKey: string;
    cwd: string;
  }) => Promise<void>;
  getSessionSnapshot: (
    sessionKey: string,
    overrides?: Partial<AcpLocalSessionPresentationRow>,
  ) => Promise<SessionSnapshot>;
  getExistingSessionSnapshot: (
    sessionKey: string,
    overrides?: Partial<AcpLocalSessionPresentationRow>,
  ) => Promise<SessionSnapshot>;
  patchSession: (
    sessionKey: string,
    patch: AcpLocalSessionPatch,
    overrides?: Partial<AcpLocalSessionPresentationRow>,
  ) => Promise<SessionSnapshot>;
  listSessions: (params: { cwd?: string; offset: number; limit: number }) => Promise<SessionInfo[]>;
  getSessionTranscript: (sessionKey: string) => Promise<AcpSessionTranscriptMessage[]>;
};

const defaultDeps: AcpLocalSessionRuntimeDeps = {
  getConfig: getRuntimeConfig,
  loadCombinedStore: (cfg) => loadCombinedSessionStore(cfg, { projection: "list" }),
  loadSession: (sessionKey) =>
    loadResolvedSessionEntryReadOnly(sessionKey, { includeStoreChildEntries: true }),
  patchEntry: patchSessionEntryTarget,
  readTranscriptEvents: readRecentSessionTranscriptMessageEvents,
  readTranscriptMessageCount: readSessionTranscriptMessageEventCount,
  readTranscriptPage: readSessionTranscriptMessageEventPage,
  resetSession: resetSessionEntryLifecycle,
  createId: randomUUID,
  now: Date.now,
};

function sessionKindForPresentation(
  sessionKey: string,
  entry: SessionEntry | undefined,
): AcpLocalSessionPresentationRow["kind"] {
  const kind = classifySessionKind(sessionKey, {
    spawnedBy: entry?.spawnedBy,
    chatType:
      entry?.delivery?.kind === "external" ? entry.delivery.route.target?.chatType : undefined,
  });
  return kind === "cron" || kind === "spawn-child" ? "direct" : kind;
}

function sessionChannel(entry: SessionEntry | undefined): string | undefined {
  return entry?.delivery?.kind === "external" ? entry.delivery.route.channel : undefined;
}

function toPresentationRow(
  sessionKey: string,
  entry: SessionEntry | undefined,
  derivedTitle?: string,
): AcpLocalSessionPresentationRow {
  return {
    key: sessionKey,
    kind: sessionKindForPresentation(sessionKey, entry),
    channel: sessionChannel(entry),
    parentSessionKey: entry?.parentSessionKey,
    spawnedBy: entry?.spawnedBy,
    spawnDepth: entry?.spawnDepth,
    subagentRole: entry?.subagentRole,
    subagentControlScope: entry?.subagentControlScope,
    spawnedWorkspaceDir: entry?.spawnedWorkspaceDir,
    spawnedCwd: entry?.spawnedCwd,
    updatedAt: entry?.updatedAt,
    displayName: entry?.displayName,
    label: entry?.label,
    derivedTitle,
    thinkingLevel: entry?.thinkingLevel,
    fastMode: entry?.fastMode,
    effectiveFastMode: entry?.fastMode,
    verboseLevel: entry?.verboseLevel,
    traceLevel: entry?.traceLevel,
    reasoningLevel: entry?.reasoningLevel,
    responseUsage: entry?.responseUsage,
    elevatedLevel: entry?.elevatedLevel,
    totalTokens: entry?.totalTokens,
    totalTokensFresh: entry?.totalTokensFresh,
    contextTokens: entry?.contextTokens,
    modelProvider: entry?.modelProvider,
    model: entry?.model,
  };
}

function storedSessionCwd(entry: SessionEntry): string | undefined {
  if (typeof entry.spawnedCwd === "string" && entry.spawnedCwd.length > 0) {
    return entry.spawnedCwd;
  }
  if (typeof entry.spawnedWorkspaceDir === "string" && entry.spawnedWorkspaceDir.length > 0) {
    return entry.spawnedWorkspaceDir;
  }
  return undefined;
}

function sessionCwd(entry: SessionEntry, fallbackCwd: string): string {
  return storedSessionCwd(entry) ?? fallbackCwd;
}

function extractTranscriptMessage(event: unknown): AcpSessionTranscriptMessage | undefined {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return undefined;
  }
  const message = (event as { message?: unknown }).message;
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return undefined;
  }
  return message as AcpSessionTranscriptMessage;
}

function extractTranscriptMessageText(message: AcpSessionTranscriptMessage): string | null {
  if (typeof message.content === "string") {
    return message.content.trim() || null;
  }
  if (!Array.isArray(message.content)) {
    return null;
  }
  const text = message.content
    .map((part) =>
      part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
        ? (part as { text: string }).text
        : "",
    )
    .filter((part) => part.trim())
    .join("\n")
    .trim();
  return text || null;
}

function applySessionPresentationPatch(
  entry: SessionEntry,
  patch: AcpLocalSessionPatch,
  now: number,
): SessionEntry {
  const next = { ...entry, updatedAt: Math.max(entry.updatedAt ?? 0, now) };

  if ("thinkingLevel" in patch) {
    if (patch.thinkingLevel === null) {
      delete next.thinkingLevel;
    } else if (patch.thinkingLevel !== undefined) {
      const normalized = normalizeThinkLevel(patch.thinkingLevel);
      if (!normalized) {
        throw new Error("invalid thinkingLevel");
      }
      next.thinkingLevel = normalized;
    }
  }

  if ("fastMode" in patch) {
    if (patch.fastMode === null) {
      delete next.fastMode;
    } else if (patch.fastMode !== undefined) {
      const normalized = normalizeFastMode(patch.fastMode);
      if (normalized === undefined) {
        throw new Error('invalid fastMode (use true, false, or "auto")');
      }
      next.fastMode = normalized;
    }
  }

  if ("verboseLevel" in patch) {
    const parsed = parseVerboseOverride(patch.verboseLevel);
    if (!parsed.ok) {
      throw new Error(parsed.error);
    }
    applyVerboseOverride(next, parsed.value);
  }

  if ("traceLevel" in patch) {
    const parsed = parseTraceOverride(patch.traceLevel);
    if (!parsed.ok) {
      throw new Error(parsed.error);
    }
    applyTraceOverride(next, parsed.value);
  }

  if ("reasoningLevel" in patch) {
    if (patch.reasoningLevel === null) {
      delete next.reasoningLevel;
    } else if (patch.reasoningLevel !== undefined) {
      const normalized = normalizeReasoningLevel(patch.reasoningLevel);
      if (!normalized) {
        throw new Error('invalid reasoningLevel (use "on"|"off"|"stream")');
      }
      next.reasoningLevel = normalized;
    }
  }

  if ("responseUsage" in patch) {
    if (patch.responseUsage === null) {
      delete next.responseUsage;
    } else if (patch.responseUsage !== undefined) {
      const normalized = normalizeUsageDisplay(patch.responseUsage);
      if (!normalized) {
        throw new Error('invalid responseUsage (use "off"|"tokens"|"full")');
      }
      next.responseUsage = normalized;
    }
  }

  if ("elevatedLevel" in patch) {
    if (patch.elevatedLevel === null) {
      delete next.elevatedLevel;
    } else if (patch.elevatedLevel !== undefined) {
      const normalized = normalizeElevatedLevel(patch.elevatedLevel);
      if (!normalized) {
        throw new Error('invalid elevatedLevel (use "on"|"off"|"ask"|"full")');
      }
      next.elevatedLevel = normalized;
    }
  }

  return next;
}

/** Creates the process-local ACP session runtime over canonical config/session accessors. */
export function createAcpLocalSessionRuntime(
  opts: AcpServerOptions = {},
  depsOverride: Partial<AcpLocalSessionRuntimeDeps> = {},
): AcpLocalSessionRuntime {
  const deps = { ...defaultDeps, ...depsOverride };

  const loadExistingSessionKey = (sessionKey: string): string | undefined => {
    const loaded = deps.loadSession(sessionKey);
    return loaded.entry ? loaded.canonicalKey : undefined;
  };

  const resolveLabel = (label: string): string => {
    const parsed = parseSessionLabel(label);
    if (!parsed.ok) {
      throw new Error(parsed.error);
    }
    const { store } = deps.loadCombinedStore(deps.getConfig());
    const matches = Object.entries(store)
      .filter(([, entry]) => normalizeOptionalString(entry.label) === parsed.label)
      .map(([sessionKey]) => sessionKey)
      .toSorted();
    if (matches.length === 0) {
      throw new Error(`Unable to resolve session label: ${parsed.label}`);
    }
    if (matches.length > 1) {
      throw new Error(
        `Multiple sessions found with label: ${parsed.label} (${matches.join(", ")})`,
      );
    }
    return matches[0] as string;
  };

  const resolveKey = (sessionKey: string, requireExisting: boolean): string => {
    const canonicalKey = resolveSessionStoreKey({
      cfg: deps.getConfig(),
      sessionKey,
    });
    if (!requireExisting) {
      return canonicalKey;
    }
    const existingKey = loadExistingSessionKey(canonicalKey);
    if (!existingKey) {
      throw new Error(`Session key not found: ${sessionKey}`);
    }
    return existingKey;
  };

  const resetSession = async (sessionKey: string, cwd: string): Promise<void> => {
    const loaded = deps.loadSession(sessionKey);
    await deps.resetSession({
      archivePreviousTranscript: false,
      agentId: resolveSessionStoreAgentId(loaded.cfg, loaded.canonicalKey),
      ...(loaded.entry ? { resetBoundaryReason: "reset" as const } : {}),
      storePath: loaded.storePath,
      target: {
        canonicalKey: loaded.canonicalKey,
        storeKeys: loaded.storeKeys,
      },
      buildNextEntry: ({ currentEntry, primaryKey }) =>
        buildSessionResetEntry({
          currentEntry,
          primaryKey,
          resetBoundaryAppended: currentEntry !== undefined,
          now: deps.now(),
          createId: deps.createId,
          spawnedCwd: currentEntry ? undefined : cwd,
        }),
    });
  };

  const readFirstUserMessage = (loaded: LoadedSessionRecord): string | null => {
    const entry = loaded.entry;
    if (!entry?.sessionId) {
      return null;
    }
    const scope = {
      agentId: resolveSessionStoreAgentId(loaded.cfg, loaded.canonicalKey),
      sessionEntry: entry,
      sessionId: entry.sessionId,
      sessionKey: loaded.canonicalKey,
      storePath: loaded.storePath,
    };
    const totalMessages = deps.readTranscriptMessageCount(scope);
    const maxMessages = Math.min(totalMessages, 100);
    if (maxMessages === 0) {
      return null;
    }
    const page = deps.readTranscriptPage(scope, {
      maxMessages,
      offset: totalMessages - maxMessages,
    });
    for (const { event } of page.events) {
      const message = extractTranscriptMessage(event);
      if (
        message?.role === "user" &&
        !hasInterSessionUserProvenance(message as { role?: unknown; provenance?: unknown })
      ) {
        return extractTranscriptMessageText(message);
      }
    }
    return null;
  };

  const getSnapshotRow = (sessionKey: string): AcpLocalSessionPresentationRow | undefined => {
    const loaded = deps.loadSession(sessionKey);
    if (!loaded.entry) {
      return undefined;
    }
    const derivedTitle = deriveSessionTitle(loaded.entry, readFirstUserMessage(loaded));
    return toPresentationRow(loaded.canonicalKey, loaded.entry, derivedTitle);
  };

  return {
    resolveSessionKey: async ({ meta, fallbackKey }) => {
      const requireExisting = meta.requireExisting ?? opts.requireExistingSession ?? false;
      if (meta.sessionLabel) {
        return resolveLabel(meta.sessionLabel);
      }
      if (meta.sessionKey) {
        return resolveKey(meta.sessionKey, requireExisting);
      }
      if (opts.defaultSessionLabel) {
        return resolveLabel(opts.defaultSessionLabel);
      }
      if (opts.defaultSessionKey) {
        return resolveKey(opts.defaultSessionKey, requireExisting);
      }
      return resolveKey(fallbackKey, requireExisting);
    },
    resetSessionIfNeeded: async ({ meta, sessionKey, cwd }) => {
      if (!(meta.resetSession ?? opts.resetSession ?? false)) {
        return;
      }
      await resetSession(sessionKey, cwd);
    },
    getSessionSnapshot: async (sessionKey, overrides) => {
      const row = getSnapshotRow(sessionKey);
      return {
        ...buildSessionPresentation({ row, overrides }),
        metadata: buildSessionMetadata({ row, sessionKey: row?.key ?? sessionKey }),
        usage: buildSessionUsageSnapshot(row),
      };
    },
    getExistingSessionSnapshot: async (sessionKey, overrides) => {
      const row = getSnapshotRow(sessionKey);
      if (!row) {
        throw new Error(`Session ${sessionKey} not found`);
      }
      return {
        ...buildSessionPresentation({ row, overrides }),
        metadata: buildSessionMetadata({ row, sessionKey: row.key }),
        usage: buildSessionUsageSnapshot(row),
      };
    },
    patchSession: async (sessionKey, patch, overrides) => {
      const loaded = deps.loadSession(sessionKey);
      const now = deps.now();
      const fallbackEntry = loaded.entry
        ? undefined
        : buildSessionResetEntry({
            primaryKey: loaded.canonicalKey,
            resetBoundaryAppended: false,
            now,
            createId: deps.createId,
            spawnedCwd: overrides?.spawnedCwd,
          });
      const updated = await deps.patchEntry(
        {
          agentId: resolveSessionStoreAgentId(loaded.cfg, loaded.canonicalKey),
          storePath: loaded.storePath,
          target: {
            canonicalKey: loaded.canonicalKey,
            storeKeys: loaded.storeKeys,
          },
        },
        (entry) => applySessionPresentationPatch(entry, patch, now),
        {
          ...(fallbackEntry ? { fallbackEntry } : {}),
          replaceEntry: true,
          skipMaintenance: true,
        },
      );
      if (!updated) {
        throw new Error(`Session ${sessionKey} changed before patch`);
      }
      const derivedTitle = deriveSessionTitle(
        updated,
        readFirstUserMessage({ ...loaded, entry: updated }),
      );
      const row = toPresentationRow(loaded.canonicalKey, updated, derivedTitle);
      return {
        ...buildSessionPresentation({ row, overrides }),
        metadata: buildSessionMetadata({ row, sessionKey: row.key }),
        usage: buildSessionUsageSnapshot(row),
      };
    },
    listSessions: async ({ cwd, offset, limit }) => {
      const fallbackCwd = process.cwd();
      const start = Math.max(0, Math.floor(offset));
      const size = Math.max(1, Math.floor(limit));
      const { store } = deps.loadCombinedStore(deps.getConfig());
      return Object.entries(store)
        .filter(([sessionKey, entry]) => {
          const kind = classifySessionKind(sessionKey, {
            spawnedBy: entry.spawnedBy,
            chatType:
              entry.delivery?.kind === "external"
                ? entry.delivery.route.target?.chatType
                : undefined,
          });
          if (kind === "cron" || sessionKey === "global" || sessionKey === "unknown") {
            return false;
          }
          // ACP cwd filters use only durable
          // workspace metadata. The response fallback must not claim legacy rows.
          return cwd === undefined || storedSessionCwd(entry) === cwd;
        })
        .toSorted(
          ([leftKey, left], [rightKey, right]) =>
            (right.updatedAt ?? 0) - (left.updatedAt ?? 0) || leftKey.localeCompare(rightKey),
        )
        .slice(start, start + size)
        .map(([sessionKey, entry]) => {
          const loaded = deps.loadSession(sessionKey);
          const resolvedTitle = deriveSessionTitle(entry, readFirstUserMessage(loaded));
          const row = toPresentationRow(sessionKey, entry, resolvedTitle);
          const updatedAt = timestampMsToIsoString(entry.updatedAt);
          const session: SessionInfo = {
            sessionId: sessionKey,
            cwd: sessionCwd(entry, fallbackCwd),
            title: resolvedTitle ?? sessionKey,
            _meta: toAcpSessionLineageMeta(row),
          };
          if (updatedAt) {
            session.updatedAt = updatedAt;
          }
          return session;
        });
    },
    getSessionTranscript: async (sessionKey) => {
      const loaded = deps.loadSession(sessionKey);
      if (!loaded.entry?.sessionId) {
        return [];
      }
      const page = deps.readTranscriptEvents(
        {
          agentId: resolveSessionStoreAgentId(loaded.cfg, loaded.canonicalKey),
          sessionEntry: loaded.entry,
          sessionId: loaded.entry.sessionId,
          sessionKey: loaded.canonicalKey,
          storePath: loaded.storePath,
        },
        {
          maxBytes: ACP_SESSION_TRANSCRIPT_MAX_BYTES,
          maxLines: ACP_SESSION_TRANSCRIPT_LIMIT * 20 + 20,
          maxMessages: ACP_SESSION_TRANSCRIPT_LIMIT,
        },
      );
      return page.events.flatMap(({ event }) => {
        const message = extractTranscriptMessage(event);
        return message ? [message] : [];
      });
    },
  };
}
