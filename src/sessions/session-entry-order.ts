import type { SessionEntry } from "../config/sessions/types.js";

const SESSION_ENTRY_TOP_N_LIMIT = 200;

export type SessionEntryPair = [string, SessionEntry];
type SessionEntrySortBy = "updatedAt" | "lastInteractionAt";

function compareSessionEntryPairs(
  a: SessionEntryPair,
  b: SessionEntryPair,
  sortBy: SessionEntrySortBy = "updatedAt",
): number {
  if (sortBy !== "lastInteractionAt") {
    const aPinnedAt = a[1]?.pinnedAt ?? 0;
    const bPinnedAt = b[1]?.pinnedAt ?? 0;
    if (aPinnedAt !== bPinnedAt) {
      return bPinnedAt - aPinnedAt;
    }
  }
  const aTimestamp = sortBy === "lastInteractionAt" ? a[1]?.lastInteractionAt : a[1]?.updatedAt;
  const bTimestamp = sortBy === "lastInteractionAt" ? b[1]?.lastInteractionAt : b[1]?.updatedAt;
  const byTimestamp = (bTimestamp ?? 0) - (aTimestamp ?? 0);
  if (byTimestamp !== 0) {
    return byTimestamp;
  }
  return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
}

function selectNewestLimitedEntries(
  entries: SessionEntryPair[],
  limit: number,
  sortBy: SessionEntrySortBy,
): SessionEntryPair[] {
  const selected: SessionEntryPair[] = [];
  for (const entry of entries) {
    const insertAt = selected.findIndex(
      (candidate) => compareSessionEntryPairs(entry, candidate, sortBy) < 0,
    );
    if (insertAt >= 0) {
      selected.splice(insertAt, 0, entry);
      if (selected.length > limit) {
        selected.pop();
      }
    } else if (selected.length < limit) {
      selected.push(entry);
    }
  }
  return selected;
}

export function sortAndLimitSessionEntries(
  entries: SessionEntryPair[],
  limit: number | undefined,
  sortBy: SessionEntrySortBy = "updatedAt",
): SessionEntryPair[] {
  if (limit !== undefined && limit <= SESSION_ENTRY_TOP_N_LIMIT) {
    return selectNewestLimitedEntries(entries, limit, sortBy);
  }
  const sorted = entries.toSorted((a, b) => compareSessionEntryPairs(a, b, sortBy));
  return limit === undefined ? sorted : sorted.slice(0, limit);
}
