import type { InternalSessionEntry as SessionEntry } from "../config/sessions.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

export const mainSessionRestartRecoveryLog = createSubsystemLogger("main-session-restart-recovery");

export const DEFAULT_RECOVERY_DELAY_MS = 5_000;
export const MAX_RECOVERY_RETRIES = 3;
export const RETRY_BACKOFF_MULTIPLIER = 2;
export const UNRESUMABLE_SESSION_NOTICE =
  "I was interrupted by a gateway restart and couldn't safely resume the previous turn. " +
  "Please send that last request again and I'll pick it up cleanly.";

export type ExpectedRestartRecoveryTarget = {
  canonicalSessionKey?: string;
  sessionId: string;
  sessionKey: string;
};

export type ExhaustedRestartRecoveryTarget = ExpectedRestartRecoveryTarget & { storePath: string };

export function normalizeStringSet(values: Iterable<string> | undefined): Set<string> {
  const normalized = new Set<string>();
  for (const value of values ?? []) {
    const trimmed = value.trim();
    if (trimmed) {
      normalized.add(trimmed);
    }
  }
  return normalized;
}

export const normalizeFiniteTimestamp = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

export function hasCurrentProcessOwner(params: {
  activeSessionIds: Set<string>;
  activeSessionKeys: Set<string>;
  entry: SessionEntry;
  sessionKey: string;
}): boolean {
  if (params.activeSessionIds.has(params.entry.sessionId)) {
    return true;
  }
  return params.activeSessionIds.size === 0 && params.activeSessionKeys.has(params.sessionKey);
}
