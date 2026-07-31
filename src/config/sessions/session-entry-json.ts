const CANONICAL_ENTRY_FIELDS = new Set(["sessionId", "updatedAt"]);

function hasDuplicateCanonicalEntryFields(json: string): boolean {
  const seen = new Set<string>();
  let depth = 0;
  let escaped = false;
  let inString = false;
  let keyStart = -1;
  let expectingTopLevelKey = false;
  for (let index = 0; index < json.length; index += 1) {
    const char = json[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
        if (keyStart >= 0) {
          const key = JSON.parse(json.slice(keyStart, index + 1)) as unknown;
          if (typeof key === "string" && CANONICAL_ENTRY_FIELDS.has(key)) {
            if (seen.has(key)) {
              return true;
            }
            seen.add(key);
          }
          keyStart = -1;
          expectingTopLevelKey = false;
        }
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      if (depth === 1 && expectingTopLevelKey) {
        keyStart = index;
      }
    } else if (char === "{" || char === "[") {
      depth += 1;
      if (depth === 1) {
        expectingTopLevelKey = true;
      }
    } else if (char === "}" || char === "]") {
      depth -= 1;
    } else if (char === "," && depth === 1) {
      expectingTopLevelKey = true;
    }
  }
  return false;
}

export function hasValidSqliteSessionEntryIdentity(entry: {
  sessionId?: unknown;
  updatedAt?: unknown;
}): entry is { sessionId: string; updatedAt: number } {
  return (
    typeof entry.sessionId === "string" &&
    (entry.sessionId === "" || entry.sessionId.trim().length > 0) &&
    !entry.sessionId.includes("\0") &&
    typeof entry.updatedAt === "number" &&
    Number.isFinite(entry.updatedAt)
  );
}

export function parseSqliteSessionEntryRecord(row: {
  current_session_id?: string;
  entry_json: string;
  updated_at?: number;
}): (Record<string, unknown> & { sessionId: string; updatedAt: number }) | null {
  try {
    const parsed = JSON.parse(row.entry_json) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    if (hasDuplicateCanonicalEntryFields(row.entry_json)) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    if (!hasValidSqliteSessionEntryIdentity(record)) {
      return null;
    }
    if (
      (row.current_session_id !== undefined && row.current_session_id !== record.sessionId) ||
      (row.updated_at !== undefined && row.updated_at !== record.updatedAt)
    ) {
      return null;
    }
    return record;
  } catch {
    return null;
  }
}
