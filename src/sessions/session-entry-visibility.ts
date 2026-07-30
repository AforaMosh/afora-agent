import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { SubagentRunReadIndex } from "../agents/subagent-registry-queries.js";
import {
  countActiveDescendantRuns,
  getSessionDisplaySubagentRunByChildSessionKey,
} from "../agents/subagent-registry-read.js";
import {
  RECENT_ENDED_SUBAGENT_CHILD_SESSION_MS,
  shouldKeepSubagentRunChildLink,
} from "../agents/subagent-run-liveness.js";
import { isTerminalSessionStatus, type SessionEntry } from "../config/sessions.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import { isCronRunSessionKey } from "./session-key-utils.js";

const STALE_STORE_ONLY_CHILD_LINK_MS = 60 * 60 * 1_000;

export type SessionEntryVisibilityOptions = {
  agentId?: string;
  archived?: boolean | "all";
  includeGlobal?: boolean;
  includeUnknown?: boolean;
  spawnedBy?: string;
};

export function isFinitePositiveTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function shouldKeepStoreOnlyChildLink(entry: SessionEntry, now: number): boolean {
  if (isTerminalSessionStatus(entry.status) || isFinitePositiveTimestamp(entry.endedAt)) {
    const endedAt = isFinitePositiveTimestamp(entry.endedAt) ? entry.endedAt : entry.updatedAt;
    return (
      isFinitePositiveTimestamp(endedAt) && now - endedAt <= RECENT_ENDED_SUBAGENT_CHILD_SESSION_MS
    );
  }
  if (entry.status === "running" || isFinitePositiveTimestamp(entry.startedAt)) {
    return true;
  }
  // Store-only child links lack a live subagent registry entry. Keep recent
  // unknown-state rows visible briefly so reloads do not hide fresh children.
  return (
    isFinitePositiveTimestamp(entry.updatedAt) &&
    now - entry.updatedAt <= STALE_STORE_ONLY_CHILD_LINK_MS
  );
}

function isPhantomAgentStoreEntry(key: string, entry: SessionEntry): boolean {
  const parsed = parseAgentSessionKey(key);
  return (
    parsed?.rest === "sessions" &&
    !normalizeOptionalString(entry.sessionId) &&
    entry.updatedAt == null
  );
}

export function isSessionEntryVisible(params: {
  entry: SessionEntry;
  key: string;
  now: number;
  options: SessionEntryVisibilityOptions;
  subagentRuns?: Pick<SubagentRunReadIndex, "countActiveDescendantRuns" | "getDisplaySubagentRun">;
}): boolean {
  const { entry, key, now, options } = params;
  const includeGlobal = options.includeGlobal === true;
  const includeUnknown = options.includeUnknown === true;
  const agentId = typeof options.agentId === "string" ? normalizeAgentId(options.agentId) : "";

  if (
    isCronRunSessionKey(key) ||
    (!includeGlobal && key === "global") ||
    (!includeUnknown && key === "unknown")
  ) {
    return false;
  }
  if (agentId) {
    if (key === "global") {
      if (!includeGlobal) {
        return false;
      }
    } else if (key === "unknown") {
      return false;
    } else {
      const parsed = parseAgentSessionKey(key);
      if (!parsed || normalizeAgentId(parsed.agentId) !== agentId) {
        return false;
      }
    }
  }
  if (isPhantomAgentStoreEntry(key, entry)) {
    return false;
  }
  if (options.archived !== "all") {
    const archived = entry.archivedAt !== undefined;
    if (options.archived === true ? !archived : archived) {
      return false;
    }
  }

  const spawnedBy = normalizeOptionalString(options.spawnedBy);
  if (!spawnedBy) {
    return true;
  }
  if (key === "unknown" || key === "global") {
    return false;
  }

  const latest = params.subagentRuns
    ? params.subagentRuns.getDisplaySubagentRun(key)
    : getSessionDisplaySubagentRunByChildSessionKey(key);
  if (latest) {
    const controllerSessionKey =
      normalizeOptionalString(latest.controllerSessionKey) ||
      normalizeOptionalString(latest.requesterSessionKey);
    return (
      controllerSessionKey === spawnedBy &&
      shouldKeepSubagentRunChildLink(latest, {
        activeDescendants: params.subagentRuns
          ? params.subagentRuns.countActiveDescendantRuns(key)
          : countActiveDescendantRuns(key),
        now,
      })
    );
  }
  return (
    shouldKeepStoreOnlyChildLink(entry, now) &&
    (entry.spawnedBy === spawnedBy || entry.parentSessionKey === spawnedBy)
  );
}
