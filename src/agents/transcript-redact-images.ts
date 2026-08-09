import { canonicalizeBase64 } from "@openclaw/media-core/base64";
import {
  sanitizeInlineImageBase64,
  sanitizeInlineImageDataUrlForStorage,
} from "@openclaw/media-core/inline-image-data-url";
import {
  readPersistedMediaBlockFactIndexes,
  readRuntimePromptMediaFacts,
} from "../media/media-facts.js";
import { projectInlineVideoContentBlock } from "../media/media-reference-projection.js";

const OMITTED_TRANSCRIPT_VIDEO_DATA = "[video data omitted]";
const TRANSCRIPT_MEDIA_WRAPPER_CARRIERS = [
  "data",
  "blob",
  "source",
  "image_url",
  "video_url",
] as const;

const isMediaMimeType = (value: unknown): value is string =>
  typeof value === "string" && /^(?:image|video)\//iu.test(value.trim());

const normalizeMediaMimeType = (value: unknown): string | undefined =>
  isMediaMimeType(value) ? value.trim().toLowerCase() : undefined;

function mediaMimeTypeForRecord(value: Record<string, unknown>): string | undefined {
  return (
    normalizeMediaMimeType(value.mimeType) ??
    normalizeMediaMimeType(value.mediaType) ??
    normalizeMediaMimeType(value.media_type)
  );
}

function mediaMimeTypeFieldsForRecord(value: Record<string, unknown>): string[] {
  return ["mimeType", "mediaType", "media_type"].filter((key) => isMediaMimeType(value[key]));
}

function sanitizeOpaqueMediaBase64(
  base64: string,
  mimeType: string | undefined,
  trustedVideo: boolean,
): { mimeType: string; base64: string } | undefined {
  if (!mimeType) {
    return undefined;
  }
  if (mimeType.startsWith("image/")) {
    return sanitizeInlineImageBase64({ mimeType, base64 });
  }
  if (!trustedVideo) {
    return undefined;
  }
  const canonicalPayload = canonicalizeBase64(base64);
  return canonicalPayload ? { mimeType, base64: canonicalPayload } : undefined;
}

function isOpaqueMediaDataBlock(value: Record<string, unknown>, trustedVideo: boolean): boolean {
  return (
    (value.type === "image" || value.type === "video" || value.type === "base64") &&
    typeof value.data === "string" &&
    sanitizeOpaqueMediaBase64(value.data, mediaMimeTypeForRecord(value), trustedVideo) !== undefined
  );
}

function isTranscriptMediaWrapper(source: Record<string, unknown>): boolean {
  return (
    Object.hasOwn(source, "type") ||
    TRANSCRIPT_MEDIA_WRAPPER_CARRIERS.some((key) => Object.hasOwn(source, key))
  );
}

function stripBareInlineVideoReferences(
  source: Record<string, unknown>,
): Record<string, unknown> | undefined {
  let projected: Record<string, unknown> | undefined;
  for (const key of ["url", "path"] as const) {
    const value = source[key];
    if (typeof value !== "string" || !/^data:video\//iu.test(value.trimStart())) {
      continue;
    }
    projected ??= { ...source };
    delete projected[key];
  }
  return projected;
}

export function sanitizeTranscriptMediaRecord(
  source: Record<string, unknown>,
  trustedVideo = false,
): Record<string, unknown> | undefined {
  if (!trustedVideo && isTranscriptMediaWrapper(source)) {
    const videoOmission = projectInlineVideoContentBlock(source);
    if (videoOmission) {
      return videoOmission;
    }
  }
  const sanitizedSource = trustedVideo
    ? source
    : (stripBareInlineVideoReferences(source) ?? source);
  const isMediaBlock = sanitizedSource.type === "image" || sanitizedSource.type === "video";
  const isBase64SourceBlock = sanitizedSource.type === "base64";
  if ((!isMediaBlock && !isBase64SourceBlock) || typeof sanitizedSource.data !== "string") {
    return sanitizedSource === source ? undefined : sanitizedSource;
  }
  const mimeTypeFields = mediaMimeTypeFieldsForRecord(sanitizedSource);
  if (mimeTypeFields.length === 0) {
    return sanitizedSource === source ? undefined : sanitizedSource;
  }
  const sanitized = sanitizeOpaqueMediaBase64(
    sanitizedSource.data,
    mediaMimeTypeForRecord(sanitizedSource),
    trustedVideo,
  );
  if (!sanitized) {
    return sanitizedSource === source ? undefined : sanitizedSource;
  }
  const hasCanonicalMimeTypes = mimeTypeFields.every(
    (key) => sanitizedSource[key] === sanitized.mimeType,
  );
  if (sanitizedSource.data === sanitized.base64 && hasCanonicalMimeTypes) {
    return sanitizedSource;
  }
  const next: Record<string, unknown> = { ...sanitizedSource, data: sanitized.base64 };
  for (const field of mimeTypeFields) {
    next[field] = sanitized.mimeType;
  }
  return next;
}

function startsWithDataUrl(value: string): boolean {
  return value.slice(0, "data:".length).toLowerCase() === "data:";
}

function sanitizeInlineMediaDataUrl(value: string, trustedVideo: boolean): string | undefined {
  const commaIndex = value.indexOf(",");
  if (commaIndex < 0) {
    return undefined;
  }
  const [mimeType, ...options] = value.slice("data:".length, commaIndex).split(";");
  const normalizedMimeType = normalizeMediaMimeType(mimeType);
  if (normalizedMimeType?.startsWith("video/") && !trustedVideo) {
    return OMITTED_TRANSCRIPT_VIDEO_DATA;
  }
  if (!normalizedMimeType || !options.some((option) => option.trim().toLowerCase() === "base64")) {
    return undefined;
  }
  if (normalizedMimeType.startsWith("image/")) {
    return sanitizeInlineImageDataUrlForStorage(value);
  }
  const sanitized = sanitizeOpaqueMediaBase64(
    value.slice(commaIndex + 1),
    normalizedMimeType,
    trustedVideo,
  );
  return sanitized ? `data:${sanitized.mimeType};base64,${sanitized.base64}` : undefined;
}

function sanitizeMediaDataUrlField(
  source: Record<string, unknown>,
  key: string,
  value: string,
  trustedVideo: boolean,
): string | undefined {
  if (!startsWithDataUrl(value)) {
    return undefined;
  }
  const isMediaDataUrlField =
    (source.type === "input_image" && key === "image_url") ||
    ((source.type === "image" || source.type === "image_url") && key === "url") ||
    (source.type === "image" && (key === "source" || key === "data")) ||
    (source.type === "input_video" && key === "video_url") ||
    ((source.type === "video" || source.type === "video_url") && key === "url") ||
    (source.type === "video" && (key === "source" || key === "data"));
  return isMediaDataUrlField ? sanitizeInlineMediaDataUrl(value, trustedVideo) : undefined;
}

export function sanitizeTranscriptMediaDataUrlField(params: {
  source: Record<string, unknown>;
  key: string;
  value: string;
  preserveMediaDataUrlFields: boolean;
  trustedVideo?: boolean;
}): string | undefined {
  if (params.preserveMediaDataUrlFields && params.key === "url") {
    return startsWithDataUrl(params.value)
      ? sanitizeInlineMediaDataUrl(params.value, params.trustedVideo === true)
      : undefined;
  }
  return sanitizeMediaDataUrlField(
    params.source,
    params.key,
    params.value,
    params.trustedVideo === true,
  );
}

export function shouldPreserveTranscriptMediaPayload(
  source: Record<string, unknown>,
  key: string,
  item: unknown,
  preserveMediaDataUrlFields: boolean,
  trustedVideo = false,
): boolean {
  if (typeof item !== "string") {
    return false;
  }
  if (key === "data" && isOpaqueMediaDataBlock(source, trustedVideo)) {
    return true;
  }
  if (preserveMediaDataUrlFields && key === "url") {
    return startsWithDataUrl(item) && sanitizeInlineMediaDataUrl(item, trustedVideo) !== undefined;
  }
  return sanitizeMediaDataUrlField(source, key, item, trustedVideo) !== undefined;
}

/** Resolves exact native video blocks backed by non-serializable runtime media provenance. */
export function collectTrustedTranscriptVideoBlocks(
  message: Record<string, unknown>,
): WeakSet<object> {
  const trusted = new WeakSet<object>();
  const mediaFacts = readRuntimePromptMediaFacts(message);
  const blockFactIndexes = readPersistedMediaBlockFactIndexes(message);
  if (!mediaFacts || !blockFactIndexes || !Array.isArray(message.content)) {
    return trusted;
  }
  const mediaBlocks = message.content.filter(
    (block): block is Record<string, unknown> =>
      Boolean(block) &&
      typeof block === "object" &&
      !Array.isArray(block) &&
      ((block as Record<string, unknown>).type === "image" ||
        (block as Record<string, unknown>).type === "video"),
  );
  if (mediaBlocks.length !== blockFactIndexes.length) {
    return trusted;
  }
  for (const [index, block] of mediaBlocks.entries()) {
    if (block.type !== "video") {
      continue;
    }
    const factIndex = blockFactIndexes[index];
    const fact = typeof factIndex === "number" ? mediaFacts[factIndex] : undefined;
    if (
      fact &&
      (fact.kind === "video" ||
        (typeof fact.contentType === "string" && /^video\//iu.test(fact.contentType.trim())))
    ) {
      trusted.add(block);
    }
  }
  return trusted;
}

export function shouldPreserveNestedTranscriptMediaDataUrlFields(
  source: Record<string, unknown>,
  key: string,
): boolean {
  return (
    (key === "image_url" &&
      (source.type === "image_url" || source.type === "input_image" || source.type === "image")) ||
    (key === "video_url" &&
      (source.type === "video_url" || source.type === "input_video" || source.type === "video"))
  );
}
