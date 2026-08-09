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
    return "";
  }
}

export function normalizeDurableMediaReference(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed || /^data:/iu.test(trimmed)) {
    return undefined;
  }
  return sanitizeMediaReferenceForProjection(trimmed) || undefined;
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
const REDACTED_INLINE_MEDIA = "[media data omitted]";
const DURABLE_MEDIA_DATA_URL_START_RE = /\bdata:(?:audio|image|video)\/[^;,\s]+(?:;[^,\s]+)*,/iu;
const MEDIA_DATA_URL_START_RE = /\bdata:[^,\s]*,/iu;
const MEDIA_PAYLOAD_MAX_DEPTH = 24;
const MEDIA_PAYLOAD_MAX_VALUES = 2_000;
const MEDIA_PAYLOAD_MAX_STRING_CHARS = 1_000_000;
const MEDIA_PAYLOAD_LIMIT_OMISSION = "[media details omitted: limit exceeded]";
const MEDIA_PAYLOAD_UNREADABLE_OMISSION = "[media details omitted: unreadable property]";
const MEDIA_PAYLOAD_BINARY_OMISSION = "[binary data omitted]";
const INLINE_VIDEO_PAYLOAD = Symbol("inline-video-payload");
const INLINE_VIDEO_PAYLOAD_MAX_NESTING = 4;
const INLINE_VIDEO_CARRIER_FIELDS = [
  "source",
  "video_url",
  "image_url",
  "data",
  "blob",
  "url",
] as const;
const VIDEO_PAYLOAD_TYPES = new Set(["video", "input_video", "video_url"]);
const VIDEO_MIME_FIELDS = [
  "mimeType",
  "mime_type",
  "mediaType",
  "media_type",
  "contentType",
  "content_type",
] as const;
const VIDEO_CLASSIFICATION_FIELDS = new Set<string>(["type", ...VIDEO_MIME_FIELDS]);

function readInlineVideoCarrier(record: object, key: string): PropertyRead | undefined {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(record, key);
  } catch {
    return undefined;
  }
  return descriptor ? readOwnProperty(record, descriptor) : undefined;
}

function hasVideoPayloadTypeOrMime(record: Record<string, unknown>): boolean {
  const typeValue = readInlineVideoCarrier(record, "type");
  const type =
    typeValue?.readable && typeof typeValue.value === "string"
      ? typeValue.value.trim().toLowerCase()
      : "";
  return (
    VIDEO_PAYLOAD_TYPES.has(type) ||
    VIDEO_MIME_FIELDS.some((field) => {
      const property = readInlineVideoCarrier(record, field);
      return (
        property?.readable === true &&
        typeof property.value === "string" &&
        /^video\//iu.test(property.value.trim())
      );
    })
  );
}

function isInlineVideoDataUrl(value: unknown): boolean {
  return typeof value === "string" && /^data:video\//iu.test(value.trimStart());
}

function isInlineVideoCarrierField(key: string): boolean {
  return (INLINE_VIDEO_CARRIER_FIELDS as readonly string[]).includes(key);
}

function containsInlineVideoPayload(
  value: unknown,
  enclosingVideo = false,
  depth = 0,
  seen: WeakSet<object> = new WeakSet<object>(),
): boolean {
  if (!value || (typeof value !== "object" && typeof value !== "function")) {
    return isInlineVideoDataUrl(value);
  }
  if (seen.has(value) || depth > INLINE_VIDEO_PAYLOAD_MAX_NESTING) {
    return false;
  }
  seen.add(value);
  const record = value as Record<string, unknown>;
  const videoContext = enclosingVideo || hasVideoPayloadTypeOrMime(record);
  for (const key of INLINE_VIDEO_CARRIER_FIELDS) {
    const property = readInlineVideoCarrier(value, key);
    if (!property?.readable) {
      continue;
    }
    const carrier = property.value;
    if (isInlineVideoDataUrl(carrier)) {
      seen.delete(value);
      return true;
    }
    if (videoContext && (key === "data" || key === "blob") && carrier !== undefined) {
      seen.delete(value);
      return true;
    }
    if (
      depth < INLINE_VIDEO_PAYLOAD_MAX_NESTING &&
      carrier &&
      (typeof carrier === "object" || typeof carrier === "function") &&
      containsInlineVideoPayload(carrier, videoContext, depth + 1, seen)
    ) {
      seen.delete(value);
      return true;
    }
  }
  seen.delete(value);
  return false;
}

/** Projects supported inline-video content wrappers to one valid durable text block. */
export function projectInlineVideoContentBlock(
  value: unknown,
): { type: "text"; text: string } | undefined {
  return value === REDACTED_INLINE_VIDEO || containsInlineVideoPayload(value)
    ? { type: "text", text: REDACTED_INLINE_VIDEO }
    : undefined;
}

function isModelVisibleMediaRecord(record: Record<string, unknown>): boolean {
  if (!("data" in record) && !("blob" in record)) {
    return false;
  }
  const type = typeof record.type === "string" ? record.type.toLowerCase() : "";
  if (type === "video" || type === "image" || type === "audio") {
    return true;
  }
  const hasMediaMime = [
    record.mimeType,
    record.mime_type,
    record.mediaType,
    record.media_type,
    record.contentType,
    record.content_type,
  ].some((value) => typeof value === "string" && /^(?:video|image|audio)\//iu.test(value.trim()));
  return hasMediaMime;
}

type PropertyRead = { readable: true; value: unknown } | { readable: false };

type OwnPropertySnapshot = {
  descriptors: Map<PropertyKey, PropertyDescriptor>;
  enumerableKeys: string[];
};

function inspectOwnProperties(value: object): OwnPropertySnapshot | undefined {
  let keys: PropertyKey[];
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    return undefined;
  }
  const descriptors = new Map<PropertyKey, PropertyDescriptor>();
  const enumerableKeys: string[] = [];
  for (const key of keys) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      return undefined;
    }
    if (!descriptor) {
      continue;
    }
    descriptors.set(key, descriptor);
    if (typeof key === "string" && descriptor.enumerable) {
      enumerableKeys.push(key);
    }
  }
  return { descriptors, enumerableKeys };
}

function readOwnProperty(value: object, descriptor: PropertyDescriptor | undefined): PropertyRead {
  if (!descriptor) {
    return { readable: false };
  }
  if ("value" in descriptor) {
    return { readable: true, value: descriptor.value };
  }
  try {
    return {
      readable: true,
      value: descriptor.get?.call(value),
    };
  } catch {
    return { readable: false };
  }
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
  mode: "durable-video" | "model-visible-media" = "durable-video",
  enclosingVideo = false,
): unknown {
  state.values += 1;
  if (depth > MEDIA_PAYLOAD_MAX_DEPTH || state.values > MEDIA_PAYLOAD_MAX_VALUES) {
    return MEDIA_PAYLOAD_LIMIT_OMISSION;
  }
  if (typeof value === "string") {
    state.stringChars += value.length;
    if (state.stringChars > MEDIA_PAYLOAD_MAX_STRING_CHARS) {
      return MEDIA_PAYLOAD_LIMIT_OMISSION;
    }
    const dataUrlIndex = value.search(
      mode === "model-visible-media" ? MEDIA_DATA_URL_START_RE : DURABLE_MEDIA_DATA_URL_START_RE,
    );
    const withoutInlineData =
      dataUrlIndex < 0 ? value : `${value.slice(0, dataUrlIndex)}${REDACTED_INLINE_MEDIA}`;
    const projected =
      withoutInlineData === value &&
      (key === "url" || key === "video_url" || key === "path") &&
      /^https?:\/\//iu.test(value)
        ? sanitizeMediaReferenceForProjection(value)
        : withoutInlineData;
    return projected;
  }
  if (!value || (typeof value !== "object" && typeof value !== "function")) {
    return value;
  }
  if (state.seen.has(value)) {
    return "[Circular]";
  }
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    return MEDIA_PAYLOAD_BINARY_OMISSION;
  }
  const ownProperties = inspectOwnProperties(value);
  if (!ownProperties) {
    return MEDIA_PAYLOAD_UNREADABLE_OMISSION;
  }
  let arrayLength: number | undefined;
  if (Array.isArray(value)) {
    const lengthDescriptor = ownProperties.descriptors.get("length");
    if (
      !lengthDescriptor ||
      !("value" in lengthDescriptor) ||
      typeof lengthDescriptor.value !== "number"
    ) {
      return MEDIA_PAYLOAD_UNREADABLE_OMISSION;
    }
    arrayLength = lengthDescriptor.value;
  }
  if (
    (arrayLength !== undefined && arrayLength > MEDIA_PAYLOAD_MAX_VALUES - state.values) ||
    (!Array.isArray(value) &&
      ownProperties.enumerableKeys.length > MEDIA_PAYLOAD_MAX_VALUES - state.values)
  ) {
    return MEDIA_PAYLOAD_LIMIT_OMISSION;
  }
  state.seen.add(value);
  if (Array.isArray(value)) {
    const length = arrayLength ?? 0;
    const projected: unknown[] = [];
    projected.length = length;
    for (let index = 0; index < length; index += 1) {
      const descriptor = ownProperties.descriptors.get(String(index));
      if (!descriptor) {
        continue;
      }
      const property = readOwnProperty(value, descriptor);
      if (!property.readable) {
        projected[index] = MEDIA_PAYLOAD_UNREADABLE_OMISSION;
        continue;
      }
      const item = projectMediaPayload(property.value, state, String(index), depth + 1, mode);
      projected[index] = item === INLINE_VIDEO_PAYLOAD ? REDACTED_INLINE_VIDEO : item;
    }
    state.seen.delete(value);
    return projected;
  }
  const source = value as Record<string, unknown>;
  const projectedEntries: Array<[string, unknown]> = [];
  const classificationEntries: Array<[string, unknown]> = [];
  const videoClassificationEntries: Array<[string, unknown]> = [];
  const videoClassificationReads = new Map<string, PropertyRead>();
  for (const propertyKey of ownProperties.enumerableKeys) {
    if (!VIDEO_CLASSIFICATION_FIELDS.has(propertyKey)) {
      continue;
    }
    const property = readOwnProperty(source, ownProperties.descriptors.get(propertyKey));
    videoClassificationReads.set(propertyKey, property);
    if (property.readable) {
      videoClassificationEntries.push([propertyKey, property.value]);
    }
  }
  const videoContext =
    enclosingVideo || hasVideoPayloadTypeOrMime(Object.fromEntries(videoClassificationEntries));
  for (const propertyKey of ownProperties.enumerableKeys) {
    if (propertyKey === "toJSON") {
      continue;
    }
    const property =
      videoClassificationReads.get(propertyKey) ??
      readOwnProperty(source, ownProperties.descriptors.get(propertyKey));
    const rawValue = property.readable ? property.value : MEDIA_PAYLOAD_UNREADABLE_OMISSION;
    classificationEntries.push([propertyKey, rawValue]);
    const carrierField = isInlineVideoCarrierField(propertyKey);
    const boundedVideoCarrier = carrierField && depth <= INLINE_VIDEO_PAYLOAD_MAX_NESTING;
    if (
      mode === "durable-video" &&
      property.readable &&
      ((videoContext &&
        (propertyKey === "data" || propertyKey === "blob") &&
        rawValue !== undefined) ||
        (boundedVideoCarrier && isInlineVideoDataUrl(rawValue)))
    ) {
      state.seen.delete(value);
      return INLINE_VIDEO_PAYLOAD;
    }
    const projectedValue = property.readable
      ? projectMediaPayload(
          rawValue,
          state,
          propertyKey,
          depth + 1,
          mode,
          carrierField && depth < INLINE_VIDEO_PAYLOAD_MAX_NESTING ? videoContext : false,
        )
      : MEDIA_PAYLOAD_UNREADABLE_OMISSION;
    if (projectedValue === INLINE_VIDEO_PAYLOAD) {
      if (carrierField && depth < INLINE_VIDEO_PAYLOAD_MAX_NESTING) {
        state.seen.delete(value);
        return INLINE_VIDEO_PAYLOAD;
      }
      projectedEntries.push([propertyKey, REDACTED_INLINE_VIDEO]);
      continue;
    }
    projectedEntries.push([propertyKey, projectedValue]);
  }
  const classificationRecord = Object.fromEntries(classificationEntries);
  if (mode === "model-visible-media" && isModelVisibleMediaRecord(classificationRecord)) {
    state.seen.delete(value);
    return REDACTED_INLINE_MEDIA;
  }
  state.seen.delete(value);
  return Object.fromEntries(projectedEntries);
}

/** Creates a detached durable snapshot, removing video bytes/data URLs and cycles. */
export function sanitizeDurableMediaPayload(value: unknown): unknown {
  const projected = projectMediaPayload(value);
  return projected === INLINE_VIDEO_PAYLOAD ? REDACTED_INLINE_VIDEO : projected;
}

/** Sanitizes a durable content-array entry while retaining a valid block shape. */
export function sanitizeDurableMediaContentBlock(value: unknown): unknown {
  const projected = projectMediaPayload(value);
  return projected === INLINE_VIDEO_PAYLOAD || projected === REDACTED_INLINE_VIDEO
    ? { type: "text", text: REDACTED_INLINE_VIDEO }
    : projected;
}

/** Creates a detached model-visible snapshot without inline media bytes, URLs, or cycles. */
export function sanitizeModelVisibleMediaPayload(value: unknown): unknown {
  return projectMediaPayload(value, undefined, undefined, 0, "model-visible-media");
}
