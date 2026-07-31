import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { stripInboundMetadata } from "../auto-reply/reply/strip-inbound-meta.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { truncateUtf16Safe } from "../utils.js";

const DERIVED_TITLE_MAX_LEN = 60;

function formatSessionIdPrefix(sessionId: string, updatedAt?: number | null): string {
  const prefix = sessionId.slice(0, 8);
  if (updatedAt && updatedAt > 0) {
    const date = new Date(updatedAt).toISOString().slice(0, 10);
    return `${prefix} (${date})`;
  }
  return prefix;
}

function truncateTitle(text: string, maxLen: number): string {
  if (text.length <= maxLen) {
    return text;
  }
  const cut = truncateUtf16Safe(text, maxLen - 1);
  const lastSpace = cut.lastIndexOf(" ");
  if (lastSpace > maxLen * 0.6) {
    return `${cut.slice(0, lastSpace)}…`;
  }
  return `${cut}…`;
}

/** Derives the stable user-facing title shared by every session projection. */
export function deriveSessionTitle(
  entry: SessionEntry | undefined,
  firstUserMessage?: string | null,
  externalDisplayName?: string | null,
): string | undefined {
  if (!entry) {
    return undefined;
  }

  const label = normalizeOptionalString(entry.label);
  if (label) {
    return label;
  }

  const displayName =
    normalizeOptionalString(externalDisplayName) ?? normalizeOptionalString(entry.displayName);
  if (displayName) {
    return displayName;
  }

  const subject = normalizeOptionalString(entry.subject);
  if (subject) {
    return subject;
  }

  // Inbound metadata is model-only and must never become a user-facing title.
  const normalized = firstUserMessage
    ? stripInboundMetadata(firstUserMessage).replace(/\s+/g, " ").trim()
    : "";
  if (normalized) {
    return truncateTitle(normalized, DERIVED_TITLE_MAX_LEN);
  }

  if (entry.sessionId) {
    return formatSessionIdPrefix(entry.sessionId, entry.updatedAt);
  }

  return undefined;
}
