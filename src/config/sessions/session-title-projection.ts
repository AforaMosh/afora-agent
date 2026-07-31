import type { DatabaseSync } from "node:sqlite";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { stripInboundMetadata } from "../../auto-reply/reply/strip-inbound-meta.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  iterateSqliteQuerySync,
} from "../../infra/kysely-sync.js";
import { hasInterSessionUserProvenance } from "../../sessions/input-provenance.js";
import { extractTextFromChatContent } from "../../shared/chat-content.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import { truncateUtf16Safe } from "../../utils.js";
import { parseSqliteSessionEntryRecord } from "./session-entry-json.js";
import { projectCanonicalSessionEntryShape } from "./store-entry-shape.js";
import type { SessionEntry } from "./types.js";

const DERIVED_TITLE_MAX_LEN = 60;
const PROJECTED_TITLE = Symbol("projectedTitle");
type ProjectedTitleEntry = SessionEntry & { [PROJECTED_TITLE]?: string };
type SessionTitleDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  | "session_nodes"
  | "session_transcript_active_events"
  | "session_windows"
  | "transcript_events"
  | "transcript_rewrite_watermarks"
>;

export function setSessionProjectedTitle(entry: SessionEntry, title: string | null): void {
  if (title) {
    Object.defineProperty(entry, PROJECTED_TITLE, {
      configurable: true,
      value: title,
      writable: true,
    });
  } else {
    delete (entry as ProjectedTitleEntry)[PROJECTED_TITLE];
  }
}

export function getSessionProjectedTitle(entry: SessionEntry | undefined): string | undefined {
  return (entry as ProjectedTitleEntry | undefined)?.[PROJECTED_TITLE];
}

export function deriveSessionTitle(
  entry: SessionEntry | undefined,
  firstUserMessage?: string | null,
  externalDisplayName?: string | null,
): string | undefined {
  if (!entry) {
    return undefined;
  }
  for (const value of [entry.label, externalDisplayName, entry.displayName, entry.subject]) {
    const title = normalizeOptionalString(value);
    if (title) {
      return title;
    }
  }
  const normalized = firstUserMessage
    ? stripInboundMetadata(firstUserMessage).replace(/\s+/g, " ").trim()
    : "";
  if (normalized) {
    if (normalized.length <= DERIVED_TITLE_MAX_LEN) {
      return normalized;
    }
    const cut = truncateUtf16Safe(normalized, DERIVED_TITLE_MAX_LEN - 1);
    const lastSpace = cut.lastIndexOf(" ");
    return lastSpace > DERIVED_TITLE_MAX_LEN * 0.6 ? `${cut.slice(0, lastSpace)}…` : `${cut}…`;
  }
  if (!entry.sessionId) {
    return undefined;
  }
  const prefix = entry.sessionId.slice(0, 8);
  const updatedAt = entry.updatedAt && entry.updatedAt > 0 ? new Date(entry.updatedAt) : null;
  return updatedAt && Number.isFinite(updatedAt.getTime())
    ? `${prefix} (${updatedAt.toISOString().slice(0, 10)})`
    : prefix;
}

export function deriveSqliteSessionTitle(
  database: DatabaseSync,
  entry: SessionEntry,
): string | null {
  const db = getNodeSqliteKysely<SessionTitleDatabase>(database);
  const rows = iterateSqliteQuerySync(
    database,
    db
      .selectFrom("session_transcript_active_events as active")
      .innerJoin("transcript_events as event", (join) =>
        join
          .onRef("event.session_id", "=", "active.session_id")
          .onRef("event.seq", "=", "active.event_seq"),
      )
      .select("event.event_json")
      .where("active.session_id", "=", entry.sessionId)
      .where("active.message_position", "is not", null)
      .orderBy("active.message_position", "asc"),
  );
  const hasActiveProjection = Boolean(
    executeSqliteQueryTakeFirstSync(
      database,
      db
        .selectFrom("session_transcript_active_events")
        .select("active_position")
        .where("session_id", "=", entry.sessionId)
        .limit(1),
    ) ??
    executeSqliteQueryTakeFirstSync(
      database,
      db
        .selectFrom("transcript_rewrite_watermarks")
        .select("generation")
        .where("session_id", "=", entry.sessionId),
    ),
  );
  if (hasActiveProjection) {
    return (
      deriveSessionTitleFromEventJson(
        entry,
        (function* () {
          for (const row of rows) {
            yield row.event_json;
          }
        })(),
      ) ?? null
    );
  }
  const provenance = executeSqliteQueryTakeFirstSync(
    database,
    db
      .selectFrom("session_windows")
      .select("session_entry_provenance")
      .where("session_id", "=", entry.sessionId),
  )?.session_entry_provenance;
  if (provenance !== 0) {
    return deriveSessionTitle(entry) ?? null;
  }
  const rawRows = iterateSqliteQuerySync(
    database,
    db
      .selectFrom("transcript_events")
      .select("event_json")
      .where("session_id", "=", entry.sessionId)
      .orderBy("seq", "asc"),
  );
  return (
    deriveSessionTitleFromEventJson(
      entry,
      (function* () {
        for (const row of rawRows) {
          yield row.event_json;
        }
      })(),
    ) ?? null
  );
}

function deriveSessionTitleFromEventJson(
  entry: SessionEntry,
  eventJsonRows: Iterable<string>,
): string | undefined {
  let firstUserMessage: string | undefined;
  for (const eventJson of eventJsonRows) {
    let parsed: { message?: unknown } | null;
    try {
      const value = JSON.parse(eventJson) as unknown;
      parsed = value && typeof value === "object" ? (value as { message?: unknown }) : null;
    } catch {
      continue;
    }
    const message = parsed?.message as
      | { content?: unknown; provenance?: unknown; role?: unknown; text?: unknown }
      | undefined;
    if (message?.role !== "user" || hasInterSessionUserProvenance(message)) {
      continue;
    }
    const text =
      extractTextFromChatContent(message.content) ??
      (typeof message.text === "string" ? message.text.trim() || null : null);
    if (text) {
      firstUserMessage = text;
      break;
    }
  }
  return deriveSessionTitle(entry, firstUserMessage);
}

export function refreshSqliteSessionTitleProjection(
  database: DatabaseSync,
  sessionId: string,
  onChanged?: () => void,
): void {
  const db = getNodeSqliteKysely<SessionTitleDatabase>(database);
  const rows = executeSqliteQuerySync(
    database,
    db
      .selectFrom("session_nodes")
      .select(["session_key", "current_session_id", "entry_json", "updated_at", "display_name"])
      .where("current_session_id", "=", sessionId),
  ).rows;
  let changed = false;
  for (const row of rows) {
    const record = parseSqliteSessionEntryRecord(row);
    if (!record) {
      continue;
    }
    const entry = projectCanonicalSessionEntryShape(record);
    const title = deriveSqliteSessionTitle(database, entry);
    if (row.display_name !== title) {
      executeSqliteQuerySync(
        database,
        db
          .updateTable("session_nodes")
          .set({ display_name: title })
          .where("session_key", "=", row.session_key),
      );
      changed = true;
    }
  }
  if (changed) {
    onChanged?.();
  }
}
