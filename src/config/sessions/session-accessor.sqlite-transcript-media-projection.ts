import {
  canonicalizePersistedUserMessageMedia,
  isVideoMediaFact,
  readPersistedMediaBlockFactIndexes,
  readPersistedMediaFacts,
} from "../../media/media-facts.js";
import {
  normalizeCanonicalInboundMediaUri,
  sanitizeDurableMediaContentBlock,
  sanitizeDurableMediaPayload,
} from "../../media/media-reference-projection.js";
import { parseInboundMediaUri } from "../../media/media-reference.js";
import type { TranscriptEvent } from "./session-accessor.sqlite-contract.js";

export function canonicalizeTranscriptEventMedia(event: TranscriptEvent): TranscriptEvent {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return event;
  }
  const record = event as Record<string, unknown>;
  if (record.type === "custom_message") {
    return sanitizeTranscriptMessagePayload(
      projectTranscriptVideoContent(record),
    ) as TranscriptEvent;
  }
  const message = record.message;
  if (
    record.type !== "message" ||
    !message ||
    typeof message !== "object" ||
    Array.isArray(message)
  ) {
    return sanitizeTranscriptMessagePayload(event) as TranscriptEvent;
  }
  const persistedMessage = projectTranscriptVideoContent(message);
  const canonical = canonicalizePersistedUserMessageMedia(persistedMessage);
  const projectedEvent =
    persistedMessage !== message || canonical.changed
      ? { ...record, message: canonical.message }
      : event;
  return {
    ...(projectedEvent as Record<string, unknown>),
    message: sanitizeTranscriptMessagePayload(
      (projectedEvent as Record<string, unknown>).message as object,
    ),
  } as TranscriptEvent;
}

function sanitizeTranscriptMessagePayload(message: object): object {
  const record = message as Record<string, unknown>;
  let changed = false;
  const projected: Record<string, unknown> = { ...record };
  const originalContent = record.content;
  if (Array.isArray(originalContent)) {
    const content = originalContent.map(sanitizeDurableMediaContentBlock);
    changed ||= content.some((block, index) => block !== originalContent[index]);
    projected.content = content;
  }
  for (const key of ["details", "diagnostics"] as const) {
    if (!(key in record)) {
      continue;
    }
    const value = sanitizeDurableMediaPayload(record[key]);
    changed ||= value !== record[key];
    projected[key] = value;
  }
  return changed ? projected : message;
}

const TRANSCRIPT_VIDEO_OMISSION =
  "(video omitted: inline video is not retained in session history)";

function isInlineVideoBlock(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { type?: unknown }).type === "video"
  );
}

function isInlineMediaBlock(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const type = (value as { type?: unknown }).type;
  return type === "image" || type === "video";
}

function isManagedVideoFact(message: object, factIndex: number | null | undefined): boolean {
  if (factIndex === null || factIndex === undefined) {
    return false;
  }
  const fact = readPersistedMediaFacts(message)?.[factIndex];
  const canonicalUrl = normalizeCanonicalInboundMediaUri(fact?.url);
  return Boolean(
    fact &&
    isVideoMediaFact(fact) &&
    canonicalUrl &&
    fact.sourceId &&
    fact.sourceIndex !== undefined &&
    parseInboundMediaUri(canonicalUrl)?.id === fact.sourceId,
  );
}

export function projectTranscriptVideoContent(message: object): object {
  const record = message as Record<string, unknown>;
  if (!Array.isArray(record.content) || !record.content.some(isInlineVideoBlock)) {
    return message;
  }

  const mediaBlockCount = record.content.filter(isInlineMediaBlock).length;
  // This producer-owned mapping is the only authority linking inline bytes to durable facts.
  // Missing or invalid provenance makes a video factless; MIME or position must never substitute.
  const persistedMediaBlockFactIndexes = readPersistedMediaBlockFactIndexes(message);
  const mediaBlockFactIndexes =
    persistedMediaBlockFactIndexes?.length === mediaBlockCount
      ? persistedMediaBlockFactIndexes
      : undefined;
  const retainedMediaBlockFactIndexes: Array<number | null> = [];
  let mediaBlockIndex = 0;
  const content = record.content.flatMap((block) => {
    const factIndex = isInlineMediaBlock(block)
      ? mediaBlockFactIndexes?.[mediaBlockIndex++]
      : undefined;
    if (!isInlineVideoBlock(block)) {
      if (isInlineMediaBlock(block) && mediaBlockFactIndexes) {
        retainedMediaBlockFactIndexes.push(factIndex ?? null);
      }
      return [block];
    }
    if (record.role === "user" && isManagedVideoFact(message, factIndex)) {
      return [];
    }
    return [{ type: "text", text: TRANSCRIPT_VIDEO_OMISSION }];
  });

  // Live messages retain media for the current provider call. Durable rows keep
  // only managed user references or a bounded omission, so old v16 readers can
  // never reinterpret a new inline-video shape after a downgrade.
  const onlyBlock = content[0];
  const persistedContent =
    record.role === "user" && content.length === 0
      ? ""
      : record.role === "user" &&
          content.length === 1 &&
          typeof onlyBlock === "object" &&
          onlyBlock !== null &&
          !Array.isArray(onlyBlock) &&
          (onlyBlock as { type?: unknown }).type === "text" &&
          typeof (onlyBlock as { text?: unknown }).text === "string"
        ? (onlyBlock as { text: string }).text
        : content;
  const projected: Record<string, unknown> = { ...record, content: persistedContent };
  const metadata = record["__openclaw"];
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    const nextMetadata = { ...(metadata as Record<string, unknown>) };
    if (mediaBlockFactIndexes && retainedMediaBlockFactIndexes.length > 0) {
      nextMetadata.mediaBlockFactIndexes = retainedMediaBlockFactIndexes;
    } else {
      delete nextMetadata.mediaBlockFactIndexes;
    }
    if (Object.keys(nextMetadata).length > 0) {
      projected["__openclaw"] = nextMetadata;
    } else {
      delete projected["__openclaw"];
    }
  }
  return projected;
}
