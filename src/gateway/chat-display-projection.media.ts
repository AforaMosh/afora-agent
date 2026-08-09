import path from "node:path";
import { estimateBase64DecodedBytes } from "@openclaw/media-core/base64";
import { asOptionalRecord as readRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeCanonicalInboundMediaUri,
  normalizeDurableMediaReference,
  projectInlineVideoContentBlock,
  sanitizeMediaReferenceForProjection,
} from "../media/media-reference-projection.js";

const AUDIO_LOCAL_PATH_FIELDS = ["path", "file", "filePath", "localPath"] as const;

function isAbsoluteStoragePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    (path.isAbsolute(value) || path.win32.isAbsolute(value) || /^file:/iu.test(value))
  );
}

export function projectChatHistoryMediaReference(value: unknown): string | undefined {
  const normalized = normalizeDurableMediaReference(value);
  return normalized && !isAbsoluteStoragePath(normalized) ? normalized : undefined;
}

function isInlineOrLocalAudioReference(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }
  const reference = value.trim();
  const isManagedRoute = /^\/(?:api\/chat\/media\/outgoing|media|__openclaw__)\//u.test(reference);
  return (
    /^data:audio\//iu.test(reference) ||
    /^file:/iu.test(reference) ||
    /^~[\\/]/u.test(reference) ||
    (!isManagedRoute &&
      (reference.startsWith("/") ||
        /^[A-Za-z]:[\\/]/u.test(reference) ||
        reference.startsWith("\\\\")))
  );
}

function omitAudioHistoryContent(
  entry: Record<string, unknown>,
  referenceFields: readonly string[],
): boolean {
  let removed = false;
  if (Object.hasOwn(entry, "data")) {
    const data = entry.data;
    delete entry.data;
    if (typeof data === "string") {
      entry.bytes = estimateBase64DecodedBytes(data);
    }
    removed = true;
  }
  for (const field of AUDIO_LOCAL_PATH_FIELDS) {
    if (Object.hasOwn(entry, field)) {
      delete entry[field];
      removed = true;
    }
  }
  for (const field of referenceFields) {
    if (isInlineOrLocalAudioReference(entry[field])) {
      delete entry[field];
      removed = true;
    }
  }
  if (removed) {
    entry.omitted = true;
  }
  return removed;
}

export function sanitizeChatHistoryMediaContentBlock(
  entry: Record<string, unknown>,
): { block: Record<string, unknown>; changed: boolean } | undefined {
  const inlineVideoOmission = projectInlineVideoContentBlock(entry);
  if (entry.type !== "video" && inlineVideoOmission) {
    return { block: inlineVideoOmission, changed: true };
  }
  const type = typeof entry.type === "string" ? entry.type : "";
  if (type === "audio") {
    let changed = omitAudioHistoryContent(entry, ["url", "openUrl", "audio_url"]);
    const source = readRecord(entry.source);
    if (source) {
      const projectedSource = { ...source };
      if (omitAudioHistoryContent(projectedSource, ["url"])) {
        entry.source = projectedSource;
        changed = true;
      }
    }
    return { block: entry, changed };
  }
  if (type !== "image" && type !== "video") {
    return undefined;
  }

  let changed = false;
  let mediaData: string | undefined;
  for (const key of ["data", "blob"] as const) {
    if (typeof entry[key] === "string") {
      mediaData ??= entry[key];
    }
    if (Object.hasOwn(entry, key)) {
      delete entry[key];
      entry.omitted = true;
      changed = true;
    }
  }
  const source = readRecord(entry.source);
  if (source && (Object.hasOwn(source, "data") || Object.hasOwn(source, "blob"))) {
    const projectedSource = { ...source };
    for (const key of ["data", "blob"] as const) {
      if (typeof source[key] === "string") {
        mediaData ??= source[key];
      }
      delete projectedSource[key];
    }
    entry.source = projectedSource;
    entry.omitted = true;
    changed = true;
  }
  if (mediaData !== undefined) {
    entry.bytes = estimateBase64DecodedBytes(mediaData);
  }
  const managedUri =
    normalizeCanonicalInboundMediaUri(entry.url) ?? normalizeCanonicalInboundMediaUri(entry.path);
  if (managedUri) {
    entry.url = managedUri;
  }
  for (const key of ["path", "filePath", "localPath"] as const) {
    if (key in entry) {
      delete entry[key];
      changed = true;
    }
  }
  if (typeof entry.url === "string") {
    if (/^data:/iu.test(entry.url) || isAbsoluteStoragePath(entry.url)) {
      delete entry.url;
    } else {
      entry.url = sanitizeMediaReferenceForProjection(entry.url);
    }
    changed = true;
  }
  if (typeof entry.source === "string") {
    const sourceUri = normalizeCanonicalInboundMediaUri(entry.source);
    if (sourceUri) {
      entry.source = sourceUri;
    } else if (/^data:/iu.test(entry.source) || isAbsoluteStoragePath(entry.source)) {
      delete entry.source;
    } else {
      entry.source = sanitizeMediaReferenceForProjection(entry.source);
    }
    changed = true;
  } else if (source) {
    const projectedSource = { ...(readRecord(entry.source) ?? source) };
    const sourceManagedUri =
      normalizeCanonicalInboundMediaUri(projectedSource.url) ??
      normalizeCanonicalInboundMediaUri(projectedSource.path);
    if (sourceManagedUri) {
      projectedSource.url = sourceManagedUri;
    }
    for (const key of ["path", "filePath", "localPath"] as const) {
      delete projectedSource[key];
    }
    if (typeof projectedSource.url === "string") {
      if (/^data:/iu.test(projectedSource.url) || isAbsoluteStoragePath(projectedSource.url)) {
        delete projectedSource.url;
      } else {
        projectedSource.url = sanitizeMediaReferenceForProjection(projectedSource.url);
      }
    }
    entry.source = projectedSource;
    changed = true;
  }
  if (type === "video" && inlineVideoOmission && entry.omitted !== true) {
    entry.omitted = true;
    changed = true;
  }
  const videoOmission = projectInlineVideoContentBlock(entry);
  return videoOmission ? { block: videoOmission, changed: true } : { block: entry, changed };
}
