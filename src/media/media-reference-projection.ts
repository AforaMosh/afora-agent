/** Removes ephemeral credentials from remote media references used in prompts or transcripts. */
export function sanitizeMediaReferenceForProjection(value: string): string {
  const trimmed = value.trim();
  if (!/^https?:\/\//iu.test(trimmed)) {
    return trimmed;
  }
  try {
    const url = new URL(trimmed);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return trimmed;
  }
}

/** Accepts only one-segment, query-free opaque inbound claim references. */
export function normalizeCanonicalInboundMediaUri(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  const match = /^media:\/\/inbound\/(.+)$/iu.exec(trimmed);
  const encodedId = match?.[1];
  if (!encodedId || /[/?#\\]/u.test(encodedId)) {
    return undefined;
  }
  try {
    const id = decodeURIComponent(encodedId);
    if (
      !id ||
      id === "." ||
      id === ".." ||
      id.includes("/") ||
      id.includes("\\") ||
      id.includes("\0")
    ) {
      return undefined;
    }
    const parsed = new URL(trimmed);
    return parsed.protocol === "media:" &&
      parsed.hostname === "inbound" &&
      !parsed.search &&
      !parsed.hash &&
      !parsed.username &&
      !parsed.password
      ? trimmed
      : undefined;
  } catch {
    return undefined;
  }
}

const REDACTED_INLINE_VIDEO = "[video data omitted]";
const VIDEO_DATA_URL_RE = /data:video\/[^;,\s]+(?:;[^,\s]+)*,[^\s"']+/giu;
const MEDIA_PAYLOAD_MAX_DEPTH = 24;
const MEDIA_PAYLOAD_MAX_VALUES = 2_000;
const MEDIA_PAYLOAD_MAX_STRING_CHARS = 1_000_000;
const MEDIA_PAYLOAD_LIMIT_OMISSION = "[media details omitted: limit exceeded]";

function isVideoRecord(record: Record<string, unknown>): boolean {
  const type = typeof record.type === "string" ? record.type.toLowerCase() : "";
  const mime = [record.mimeType, record.mime_type, record.mediaType, record.media_type].find(
    (value) => typeof value === "string",
  );
  return type === "video" || (typeof mime === "string" && /^video\//iu.test(mime));
}

function isPlainRecord(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasTooManyEnumerableKeys(record: Record<string, unknown>, limit: number): boolean {
  let count = 0;
  for (const _key in record) {
    count += 1;
    if (count > limit) {
      return true;
    }
  }
  return false;
}

function projectMediaPayload(
  value: unknown,
  state: { values: number; stringChars: number; seen: WeakSet<object> } = {
    values: 0,
    stringChars: 0,
    seen: new WeakSet(),
  },
  key?: string,
  depth = 0,
  enforceLimits = true,
): { changed: boolean; value: unknown } {
  state.values += 1;
  if (
    enforceLimits &&
    (depth > MEDIA_PAYLOAD_MAX_DEPTH || state.values > MEDIA_PAYLOAD_MAX_VALUES)
  ) {
    return { changed: true, value: MEDIA_PAYLOAD_LIMIT_OMISSION };
  }
  if (typeof value === "string") {
    state.stringChars += value.length;
    if (enforceLimits && state.stringChars > MEDIA_PAYLOAD_MAX_STRING_CHARS) {
      return { changed: true, value: MEDIA_PAYLOAD_LIMIT_OMISSION };
    }
    const withoutVideoData = value.replace(VIDEO_DATA_URL_RE, REDACTED_INLINE_VIDEO);
    const projected =
      withoutVideoData === value &&
      (key === "url" || key === "video_url" || key === "path") &&
      /^https?:\/\//iu.test(value)
        ? sanitizeMediaReferenceForProjection(value)
        : withoutVideoData;
    return { changed: projected !== value, value: projected };
  }
  if (!value || typeof value !== "object") {
    return { changed: false, value };
  }
  if (state.seen.has(value)) {
    return { changed: true, value: "[Circular]" };
  }
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    return { changed: false, value };
  }
  if (!Array.isArray(value) && !isPlainRecord(value)) {
    return { changed: false, value };
  }
  if (
    enforceLimits &&
    ((Array.isArray(value) && value.length > MEDIA_PAYLOAD_MAX_VALUES - state.values) ||
      (!Array.isArray(value) &&
        hasTooManyEnumerableKeys(value, MEDIA_PAYLOAD_MAX_VALUES - state.values)))
  ) {
    return { changed: true, value: MEDIA_PAYLOAD_LIMIT_OMISSION };
  }
  state.seen.add(value);
  if (Array.isArray(value)) {
    let changed = false;
    const projected = value.map((entry) => {
      const result = projectMediaPayload(entry, state, undefined, depth + 1, enforceLimits);
      changed ||= result.changed;
      return result.value;
    });
    state.seen.delete(value);
    if (!changed) {
      return { changed: false, value };
    }
    return { changed: true, value: projected };
  }
  const source = value;
  if (isVideoRecord(source)) {
    state.seen.delete(value);
    return { changed: true, value: REDACTED_INLINE_VIDEO };
  }
  let changed = false;
  const projected: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(source)) {
    const result = projectMediaPayload(entry, state, key, depth + 1, enforceLimits);
    changed ||= result.changed;
    projected[key] = result.value;
  }
  state.seen.delete(value);
  return changed ? { changed: true, value: projected } : { changed: false, value };
}

/** Removes durable video bytes/data URLs and breaks cycles into safe text. */
export function sanitizeDurableMediaPayload(
  value: unknown,
  options?: { enforceLimits?: boolean },
): unknown {
  return projectMediaPayload(value, undefined, undefined, 0, options?.enforceLimits).value;
}
