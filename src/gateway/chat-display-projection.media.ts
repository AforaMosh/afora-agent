import path from "node:path";
import { estimateBase64DecodedBytes } from "@openclaw/media-core/base64";
import { asOptionalRecord as readRecord } from "@openclaw/normalization-core/record-coerce";
import {
  isMediaPayloadContainerKey,
  isMediaReferenceCarrierKey,
  normalizeCanonicalInboundMediaUri,
  normalizeDurableMediaReference,
  projectInlineVideoContentBlock,
  sanitizeDurableMediaPayload,
  sanitizeMediaReferenceForProjection,
  sanitizeModelVisibleMediaPayload,
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

function projectStringMediaReference(entry: Record<string, unknown>, key: string): boolean {
  const reference = entry[key];
  if (typeof reference !== "string" || isManagedChatMediaRoute(reference)) {
    return false;
  }
  const projected = projectChatHistoryMediaReference(reference);
  if (projected === undefined) {
    delete entry[key];
    return true;
  }
  if (projected !== reference) {
    entry[key] = projected;
    return true;
  }
  return false;
}

function isMediaReferenceField(key: string): boolean {
  return key.trim().toLowerCase() === "source" || isMediaReferenceCarrierKey(key);
}

function isManagedChatMediaRoute(value: string): boolean {
  return /^\/(?:api\/chat\/media\/outgoing|media|__openclaw__)\//u.test(value.trim());
}

function isPrivateLocalMediaReference(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const reference = value.trim();
  return (
    /^file:/iu.test(reference) ||
    /^~[\\/]/u.test(reference) ||
    (!isManagedChatMediaRoute(reference) &&
      (path.isAbsolute(reference) ||
        path.win32.isAbsolute(reference) ||
        reference.startsWith("\\\\")))
  );
}

function isInlineOrLocalAudioReference(value: unknown): boolean {
  return (
    (typeof value === "string" && /^data:audio\//iu.test(value.trim())) ||
    isPrivateLocalMediaReference(value)
  );
}

// Call only on the bounded detached snapshot. Once a reference field opens a
// subtree, inspect nested objects while treating direct array strings as refs.
function stripPrivateLocalMediaReferences(
  value: unknown,
  insideReference = false,
  directReference = false,
): void {
  if (Array.isArray(value)) {
    for (let index = value.length - 1; index >= 0; index -= 1) {
      const item = value[index];
      if (directReference && isPrivateLocalMediaReference(item)) {
        value.splice(index, 1);
        continue;
      }
      if (item && typeof item === "object") {
        stripPrivateLocalMediaReferences(item, insideReference);
      }
    }
    return;
  }
  const record = readRecord(value);
  if (!record) {
    return;
  }
  for (const [key, child] of Object.entries(record)) {
    const referenceField = isMediaReferenceField(key);
    if (referenceField && isPrivateLocalMediaReference(child)) {
      delete record[key];
      continue;
    }
    if ((insideReference || referenceField) && child && typeof child === "object") {
      stripPrivateLocalMediaReferences(child, true, referenceField && Array.isArray(child));
    }
  }
}

function omitAudioHistoryContent(
  entry: Record<string, unknown>,
  referenceFields: readonly string[],
): boolean {
  let changed = false;
  let omitted = false;
  if (Object.hasOwn(entry, "data")) {
    const data = entry.data;
    delete entry.data;
    if (typeof data === "string") {
      entry.bytes = estimateBase64DecodedBytes(data);
    }
    changed = true;
    omitted = true;
  }
  for (const field of AUDIO_LOCAL_PATH_FIELDS) {
    if (Object.hasOwn(entry, field)) {
      delete entry[field];
      changed = true;
      omitted = true;
    }
  }
  for (const field of referenceFields) {
    const reference = entry[field];
    if (isInlineOrLocalAudioReference(reference)) {
      delete entry[field];
      changed = true;
      omitted = true;
      continue;
    }
    if (projectStringMediaReference(entry, field)) {
      changed = true;
    }
  }
  if (omitted) {
    entry.omitted = true;
  }
  return changed;
}

export function sanitizeChatHistoryMediaContentBlock(
  entry: Record<string, unknown>,
): { block: Record<string, unknown>; changed: boolean } | undefined {
  const type = typeof entry.type === "string" ? entry.type : "";
  if (
    type !== "audio" &&
    type !== "image" &&
    type !== "video" &&
    isMediaPayloadContainerKey(type)
  ) {
    const durable = sanitizeDurableMediaPayload(entry);
    const inlineVideoOmission = projectInlineVideoContentBlock(durable);
    if (inlineVideoOmission) {
      return { block: inlineVideoOmission, changed: true };
    }
    const bounded = sanitizeModelVisibleMediaPayload(durable);
    const projected = readRecord(bounded) ?? { type, omitted: true };
    stripPrivateLocalMediaReferences(projected);
    return { block: projected, changed: true };
  }
  const inlineVideoOmission = projectInlineVideoContentBlock(entry);
  if (entry.type !== "video" && inlineVideoOmission) {
    return { block: inlineVideoOmission, changed: true };
  }
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
  for (const key of ["url", "openUrl", "file", "image_url", "video_url", "audio_url"] as const) {
    if (projectStringMediaReference(entry, key)) {
      changed = true;
    }
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
