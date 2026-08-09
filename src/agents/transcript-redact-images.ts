import {
  sanitizeInlineImageBase64,
  sanitizeInlineImageDataUrlForStorage,
} from "@openclaw/media-core/inline-image-data-url";
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
): { mimeType: string; base64: string } | undefined {
  if (!mimeType?.startsWith("image/")) {
    return undefined;
  }
  return sanitizeInlineImageBase64({ mimeType, base64 });
}

function isOpaqueMediaDataBlock(value: Record<string, unknown>): boolean {
  return (
    (value.type === "image" || value.type === "video" || value.type === "base64") &&
    typeof value.data === "string" &&
    sanitizeOpaqueMediaBase64(value.data, mediaMimeTypeForRecord(value)) !== undefined
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
): Record<string, unknown> | undefined {
  if (isTranscriptMediaWrapper(source)) {
    const videoOmission = projectInlineVideoContentBlock(source);
    if (videoOmission) {
      return videoOmission;
    }
  }
  const sanitizedSource = stripBareInlineVideoReferences(source) ?? source;
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

function sanitizeInlineMediaDataUrl(value: string): string | undefined {
  const commaIndex = value.indexOf(",");
  if (commaIndex < 0) {
    return undefined;
  }
  const [mimeType, ...options] = value.slice("data:".length, commaIndex).split(";");
  const normalizedMimeType = normalizeMediaMimeType(mimeType);
  if (normalizedMimeType?.startsWith("video/")) {
    return OMITTED_TRANSCRIPT_VIDEO_DATA;
  }
  if (!normalizedMimeType || !options.some((option) => option.trim().toLowerCase() === "base64")) {
    return undefined;
  }
  return sanitizeInlineImageDataUrlForStorage(value);
}

function sanitizeMediaDataUrlField(
  source: Record<string, unknown>,
  key: string,
  value: string,
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
  return isMediaDataUrlField ? sanitizeInlineMediaDataUrl(value) : undefined;
}

export function sanitizeTranscriptMediaDataUrlField(params: {
  source: Record<string, unknown>;
  key: string;
  value: string;
  preserveMediaDataUrlFields: boolean;
}): string | undefined {
  if (params.preserveMediaDataUrlFields && params.key === "url") {
    return startsWithDataUrl(params.value) ? sanitizeInlineMediaDataUrl(params.value) : undefined;
  }
  return sanitizeMediaDataUrlField(params.source, params.key, params.value);
}

export function shouldPreserveTranscriptMediaPayload(
  source: Record<string, unknown>,
  key: string,
  item: unknown,
  preserveMediaDataUrlFields: boolean,
): boolean {
  if (typeof item !== "string") {
    return false;
  }
  if (key === "data" && isOpaqueMediaDataBlock(source)) {
    return true;
  }
  if (preserveMediaDataUrlFields && key === "url") {
    return startsWithDataUrl(item) && sanitizeInlineMediaDataUrl(item) !== undefined;
  }
  return sanitizeMediaDataUrlField(source, key, item) !== undefined;
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
