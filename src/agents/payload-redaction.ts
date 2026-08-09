/**
 * Redacts diagnostic payloads before persistence. It removes credential-like
 * fields, masks embedded auth strings, and replaces inline media/base64 data with
 * size and digest metadata.
 */
import crypto from "node:crypto";
import { estimateBase64DecodedBytes } from "@openclaw/media-core/base64";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

const REDACTED_MEDIA_DATA = "<redacted>";
const REDACTED_MEDIA_REFERENCE = "<redacted-media-reference>";
const INLINE_MEDIA_DATA_URL_RE = /^data:((image|video)\/[^;,]+);base64,([\s\S]*)$/iu;
const EMBEDDED_MEDIA_DATA_URL_RE =
  /data:(?:image|video)\/[^;,\s]+(?:;[^,\s]+)*;base64,[A-Za-z0-9+/_=-]+/giu;
const MEDIA_ATTACHED_NOTE_RE = /\[media attached(?: [^:\]]+)?:[^\]]*\]/giu;
const MEDIA_DIRECTIVE_RE = /\bMEDIA:(?:file:\/\/)?[^\s]+/giu;
const MEDIA_REFERENCE_FIELDS = new Set([
  "file_path",
  "filePath",
  "image_url",
  "localPath",
  "path",
  "url",
  "video_url",
]);
const INLINE_MEDIA_TYPES = new Set([
  "audio",
  "audio_url",
  "base64",
  "image",
  "image_url",
  "input_audio",
  "input_image",
  "input_video",
  "output_audio",
  "video",
  "video_url",
]);
const INLINE_MEDIA_MIME_FIELDS = [
  "mimeType",
  "mime_type",
  "mediaType",
  "media_type",
  "contentType",
  "content_type",
] as const;

const NON_CREDENTIAL_FIELD_NAMES = new Set([
  "passwordfile",
  "tokenbudget",
  "tokencount",
  "tokenfield",
  "tokenlimit",
  "tokens",
]);

const AUTHORIZATION_VALUE_RE = /\b(Bearer|Basic)\s+[A-Za-z0-9+/._~=-]{8,}/giu;
const JWT_VALUE_RE = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/gu;
const COOKIE_PAIR_RE = /\b([A-Za-z][A-Za-z0-9_.-]{1,64})=([A-Za-z0-9+/._~%=-]{16,})(?=;|\s|$)/gu;

function normalizeFieldName(value: string): string {
  return normalizeLowercaseStringOrEmpty(value.replaceAll(/[^a-z0-9]/gi, ""));
}

function isCredentialFieldName(key: string): boolean {
  const normalized = normalizeFieldName(key);
  if (!normalized || NON_CREDENTIAL_FIELD_NAMES.has(normalized)) {
    return false;
  }
  if (normalized === "authorization" || normalized === "proxyauthorization") {
    return true;
  }
  return (
    normalized.endsWith("apikey") ||
    normalized.endsWith("password") ||
    normalized.endsWith("passwd") ||
    normalized.endsWith("passphrase") ||
    normalized.endsWith("secret") ||
    normalized.endsWith("secretkey") ||
    normalized.endsWith("token")
  );
}

function redactSensitivePayloadString(value: string): string {
  return value
    .replace(AUTHORIZATION_VALUE_RE, "$1 <redacted>")
    .replace(JWT_VALUE_RE, "<redacted-jwt>")
    .replace(COOKIE_PAIR_RE, "$1=<redacted>");
}

function redactModelVisibleMediaString(value: string): string {
  return value
    .replace(EMBEDDED_MEDIA_DATA_URL_RE, REDACTED_MEDIA_DATA)
    .replace(MEDIA_ATTACHED_NOTE_RE, `[media attached: ${REDACTED_MEDIA_REFERENCE}]`)
    .replace(MEDIA_DIRECTIVE_RE, `MEDIA:${REDACTED_MEDIA_REFERENCE}`);
}

function hasSensitiveNameValuePair(record: Record<string, unknown>): boolean {
  const rawName = typeof record.name === "string" ? record.name : record.key;
  return typeof rawName === "string" && isCredentialFieldName(rawName);
}

function hasInlineMediaMime(record: Record<string, unknown>): boolean {
  return INLINE_MEDIA_MIME_FIELDS.some((field) => {
    const value = normalizeLowercaseStringOrEmpty(record[field]);
    return (
      value.startsWith("image/") ||
      value.startsWith("audio/") ||
      value.startsWith("video/") ||
      value === "application/pdf"
    );
  });
}

function isMediaProjectionRecord(record: Record<string, unknown>): boolean {
  const type = normalizeLowercaseStringOrEmpty(record.type);
  return INLINE_MEDIA_TYPES.has(type) || hasInlineMediaMime(record);
}

function digestBase64Payload(data: string): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function redactInlineMediaData(
  record: Record<string, unknown>,
  field: string,
  data: string,
  mimeType?: string,
): void {
  record[field] = REDACTED_MEDIA_DATA;
  if (mimeType && typeof record.mimeType !== "string") {
    record.mimeType = mimeType;
  }
  record.bytes = estimateBase64DecodedBytes(data);
  record.sha256 = digestBase64Payload(data);
}

function redactInlineMediaFields(
  record: Record<string, unknown>,
  out: Record<string, unknown>,
  mediaContext: boolean,
): void {
  if (!mediaContext) {
    return;
  }
  const field = typeof record.data === "string" ? "data" : "blob";
  const data = record[field];
  if (typeof data !== "string") {
    return;
  }
  redactInlineMediaData(out, field, data);
  const otherField = field === "data" ? "blob" : "data";
  if (typeof record[otherField] === "string") {
    out[otherField] = REDACTED_MEDIA_DATA;
  }
}

function redactInlineMediaDataUrl(
  record: Record<string, unknown>,
  out: Record<string, unknown>,
): void {
  const type = normalizeLowercaseStringOrEmpty(record.type);
  const mediaKind =
    type === "image_url" || type === "input_image"
      ? "image"
      : type === "video_url" || type === "input_video"
        ? "video"
        : undefined;
  if (!mediaKind) {
    return;
  }

  const field = `${mediaKind}_url`;
  const value = record[field];
  const nested = value && typeof value === "object" && !Array.isArray(value);
  const url = nested ? (value as Record<string, unknown>).url : value;
  if (typeof url !== "string") {
    return;
  }
  const match = INLINE_MEDIA_DATA_URL_RE.exec(url);
  const mimeType = match?.[1];
  const data = match?.[3];
  if (
    !mimeType ||
    data === undefined ||
    normalizeLowercaseStringOrEmpty(match?.[2]) !== mediaKind
  ) {
    return;
  }

  const target = nested ? out[field] : out;
  if (!target || typeof target !== "object" || Array.isArray(target)) {
    return;
  }
  redactInlineMediaData(target as Record<string, unknown>, nested ? "url" : field, data, mimeType);
}

function visitDiagnosticPayload(
  value: unknown,
  opts?: {
    omitField?: (key: string) => boolean;
    redactMediaLocations?: boolean;
    redactMediaDataUrlsInText?: boolean;
  },
): unknown {
  const seen = new WeakSet<object>();

  const visit = (input: unknown, insideMedia = false): unknown => {
    if (Array.isArray(input)) {
      return input.map((entry) => visit(entry, insideMedia));
    }
    if (typeof input === "string") {
      const redacted = redactSensitivePayloadString(input);
      return opts?.redactMediaDataUrlsInText ? redactModelVisibleMediaString(redacted) : redacted;
    }
    if (!input || typeof input !== "object") {
      return input;
    }
    if (seen.has(input)) {
      return "[Circular]";
    }
    seen.add(input);

    const record = input as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    const redactValueField = hasSensitiveNameValuePair(record);
    const mediaContext = insideMedia || isMediaProjectionRecord(record);
    for (const [key, val] of Object.entries(record)) {
      if (opts?.omitField?.(key)) {
        continue;
      }
      if (
        opts?.redactMediaLocations &&
        mediaContext &&
        MEDIA_REFERENCE_FIELDS.has(key) &&
        typeof val === "string"
      ) {
        out[key] = REDACTED_MEDIA_REFERENCE;
        continue;
      }
      out[key] = redactValueField && key === "value" ? "<redacted>" : visit(val, mediaContext);
    }

    redactInlineMediaFields(record, out, mediaContext);
    redactInlineMediaDataUrl(record, out);
    return out;
  };

  return visit(value);
}

/**
 * Removes credential-like fields and inline media/base64 payload data from diagnostic
 * objects before persistence.
 */
export function sanitizeDiagnosticPayload(value: unknown): unknown {
  return visitDiagnosticPayload(value, {
    omitField: (key) => key === "providerReplay" || isCredentialFieldName(key),
  });
}

/** Projects untrusted media into model-visible metadata without bytes, data URLs, or local refs. */
export function sanitizeModelVisibleMediaPayload(value: unknown): unknown {
  return visitDiagnosticPayload(value, {
    omitField: isCredentialFieldName,
    redactMediaDataUrlsInText: true,
    redactMediaLocations: true,
  });
}
