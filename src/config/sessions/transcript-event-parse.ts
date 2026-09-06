// Stored transcript events are parsed here so one rename is undone in one place.
import type { TranscriptEvent } from "./session-accessor.types.js";

const MESSAGE_METADATA_KEY = "__afora";
const LEGACY_MESSAGE_METADATA_KEY = "__openclaw"; // afora-compat: pre-rename metadata key

/**
 * afora-compat: every message a tenant persisted before the rename carries its
 * metadata sidecar under `__openclaw`. The rename moved the write side and the
 * ~80 read sites together, so no grep finds a mismatch anywhere in the source:
 * the third side is the data already on disk. Adopt the key as the record is
 * read, once, rather than teaching every reader a fallback it would eventually
 * forget. Only a record the caller rewrites anyway is ever written back under
 * the current name; nothing here migrates a tenant's database.
 *
 * Without this, a pre-rename turn loses its media references, its mirror origin
 * and its sequence number the moment the gateway starts reading the tenant's
 * real database, which is exactly what the agent-database dual-read now makes
 * it do.
 */
export function adoptLegacyMessageMetadata<T>(event: T): T {
  const message = (event as { message?: unknown } | null | undefined)?.message;
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return event;
  }
  const record = message as Record<string, unknown>;
  if (!(LEGACY_MESSAGE_METADATA_KEY in record) || MESSAGE_METADATA_KEY in record) {
    return event;
  }
  record[MESSAGE_METADATA_KEY] = record[LEGACY_MESSAGE_METADATA_KEY];
  delete record[LEGACY_MESSAGE_METADATA_KEY];
  return event;
}

/** Parse one stored transcript event row or transcript line. */
export function parseTranscriptEventJson(json: string): TranscriptEvent {
  return adoptLegacyMessageMetadata(JSON.parse(json)) as TranscriptEvent;
}
