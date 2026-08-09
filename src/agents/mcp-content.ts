import { canonicalizeBase64, estimateBase64DecodedBytes } from "@openclaw/media-core/base64";
import { MAX_IMAGE_BYTES } from "@openclaw/media-core/constants";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  isMediaPayloadContainerKey,
  sanitizeMediaReferenceForProjection,
} from "../media/media-reference-projection.js";
import { truncateUtf8Prefix } from "../utils/utf8-truncate.js";
import type { AgentToolResult } from "./runtime/index.js";

type McpAgentContentBlock = AgentToolResult<unknown>["content"][number];

const MCP_CONTENT_MAX_BLOCKS = 200;
const MCP_TEXT_CONTENT_MAX_BYTES = 1024 * 1024;
const MCP_RESULT_MAX_BYTES = 20 * 1024 * 1024;
const MCP_STRUCTURED_MAX_BYTES = 1024 * 1024;

const MCP_STRUCTURED_MAX_VALUES = 1_000;
const MCP_STRUCTURED_MAX_STRING_CHARS = 64_000;
const MCP_IMAGE_MAX_ENCODED_CHARS = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;
const MCP_TEXT_TRUNCATION_MARKER = "\n[truncated: MCP text content exceeded 1 MB]";
const MCP_RESULT_TRUNCATION_MARKER = "[truncated: MCP result exceeded 20 MB]";
const MCP_STRUCTURED_TRUNCATION_MARKER = "[MCP structured output omitted: limit exceeded]";
const MCP_VALUE_COUNT_MARKER = "[MCP values omitted: count limit exceeded]";
const MCP_BINARY_PLACEHOLDER = "[binary omitted]";
const MCP_DATA_URL_PLACEHOLDER = "[data URL omitted]";
const MCP_LOCAL_URI_PLACEHOLDER = "[local resource URI omitted]";
const MCP_EMBEDDED_DATA_URL_RE = /data:[^,\s]+,[\s\S]*$/iu;
const MCP_STRING_TRUNCATION_MARKER = "[truncated: MCP string exceeded 64,000 characters]";
function isInlineDataUrl(value: string): boolean {
  return /^\s*data:/iu.test(value);
}

function sanitizeMcpString(value: string): string {
  const redacted = value.replace(MCP_EMBEDDED_DATA_URL_RE, MCP_DATA_URL_PLACEHOLDER);
  const truncated = truncateUtf16Safe(redacted, MCP_STRUCTURED_MAX_STRING_CHARS);
  return truncated.length < redacted.length
    ? `${truncated}\n${MCP_STRING_TRUNCATION_MARKER}`
    : truncated;
}

function sanitizeMcpResourceUri(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  const trimmed = value.trim();
  if (isInlineDataUrl(trimmed)) {
    return MCP_DATA_URL_PLACEHOLDER;
  }
  if (/^file:/iu.test(trimmed)) {
    return MCP_LOCAL_URI_PLACEHOLDER;
  }
  return sanitizeMediaReferenceForProjection(trimmed);
}

function normalizeMcpMimeType(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  return normalized.length <= 127 && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/iu.test(normalized)
    ? normalized
    : undefined;
}

function mediaMimeType(record: Record<string, unknown>): string | undefined {
  for (const candidate of [
    record.mimeType,
    record.mime_type,
    record.contentType,
    record.content_type,
    record.mediaType,
    record.media_type,
  ]) {
    const mimeType = normalizeMcpMimeType(candidate);
    if (mimeType && /^(?:audio|image|video)\//u.test(mimeType)) {
      return mimeType;
    }
  }
  return undefined;
}

function recordCarriesStructuredMedia(
  record: Record<string, unknown>,
  inheritedMediaContext: boolean,
): boolean {
  const type = typeof record.type === "string" ? record.type.trim().toLowerCase() : "";
  return (
    inheritedMediaContext || isMediaPayloadContainerKey(type) || mediaMimeType(record) !== undefined
  );
}

function projectMcpJsonValueInner(
  value: unknown,
  state: { values: number; truncated: boolean; seen: WeakSet<object> },
  mediaContext = false,
  scalarMediaContext = false,
): unknown {
  state.values += 1;
  if (state.values > MCP_STRUCTURED_MAX_VALUES) {
    state.truncated = true;
    return MCP_VALUE_COUNT_MARKER;
  }
  if (typeof value === "string") {
    if (scalarMediaContext) {
      return MCP_BINARY_PLACEHOLDER;
    }
    const projected = sanitizeMcpString(value);
    state.truncated ||= projected.length < value.length;
    return projected;
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  if (state.seen.has(value)) {
    return "[Circular]";
  }
  state.seen.add(value);
  if (Array.isArray(value)) {
    const projected: unknown[] = [];
    for (const entry of value) {
      if (state.values >= MCP_STRUCTURED_MAX_VALUES) {
        projected.push(MCP_VALUE_COUNT_MARKER);
        state.truncated = true;
        break;
      }
      projected.push(projectMcpJsonValueInner(entry, state, mediaContext, scalarMediaContext));
    }
    state.seen.delete(value);
    return projected;
  }

  const source = value as Record<string, unknown>;
  const projected: Record<string, unknown> = {};
  const recordMediaContext = recordCarriesStructuredMedia(source, mediaContext);
  for (const [key, entry] of Object.entries(source)) {
    if (state.values >= MCP_STRUCTURED_MAX_VALUES) {
      projected.omitted = MCP_VALUE_COUNT_MARKER;
      state.truncated = true;
      break;
    }
    if (key === "blob" || (key === "data" && recordMediaContext)) {
      projected[key] = MCP_BINARY_PLACEHOLDER;
      continue;
    }
    if ((key === "uri" || key === "url") && typeof entry === "string") {
      projected[key] = sanitizeMcpResourceUri(entry) ?? "[resource URI omitted]";
      continue;
    }
    const aliasMediaContext = isMediaPayloadContainerKey(key);
    projected[key] = projectMcpJsonValueInner(
      entry,
      state,
      recordMediaContext || aliasMediaContext,
      aliasMediaContext,
    );
  }
  state.seen.delete(value);
  return projected;
}

/** Deeply removes MCP binary/data-URL values and returns an allocation-bounded JSON value. */
export function projectMcpJsonValue(value: unknown): unknown {
  const state = { values: 0, truncated: false, seen: new WeakSet<object>() };
  const projected = projectMcpJsonValueInner(value, state);
  try {
    if (Buffer.byteLength(JSON.stringify(projected)) <= MCP_STRUCTURED_MAX_BYTES) {
      return projected;
    }
  } catch {
    return { omitted: MCP_STRUCTURED_TRUNCATION_MARKER };
  }
  return { omitted: MCP_STRUCTURED_TRUNCATION_MARKER };
}

export function stringifyMcpJsonValue(value: unknown): string {
  return JSON.stringify(projectMcpJsonValue(value), null, 2) ?? "null";
}

function describeResource(params: {
  mimeType: string | undefined;
  uri: string | undefined;
  binary: boolean;
}): McpAgentContentBlock {
  const kind = params.mimeType?.startsWith("video/")
    ? "video"
    : params.mimeType?.startsWith("image/")
      ? "image"
      : params.mimeType?.startsWith("audio/")
        ? "audio"
        : "binary";
  const label = params.binary ? `[${kind} resource omitted]` : `[resource]`;
  const mime = params.mimeType ? ` (${params.mimeType})` : "";
  const uri = params.uri ? ` ${params.uri}` : "";
  return { type: "text", text: `${label}${mime}${uri}` };
}

/** Converts one SDK-legal MCP content block into bounded agent text/image content. */
function mcpContentBlockToAgentContent(block: unknown): McpAgentContentBlock {
  if (!isRecord(block)) {
    return { type: "text", text: "[unsupported MCP content omitted]" };
  }
  switch (block.type) {
    case "text":
      return {
        type: "text",
        text: typeof block.text === "string" ? sanitizeMcpString(block.text) : "[invalid MCP text]",
      };
    case "image": {
      const mimeType = normalizeMcpMimeType(block.mimeType);
      if (
        typeof block.data === "string" &&
        block.data.length <= MCP_IMAGE_MAX_ENCODED_CHARS &&
        mimeType?.startsWith("image/") &&
        estimateBase64DecodedBytes(block.data) <= MAX_IMAGE_BYTES
      ) {
        const data = canonicalizeBase64(block.data);
        if (data) {
          return { type: "image", data, mimeType };
        }
      }
      return { type: "text", text: "[image omitted: invalid MCP image]" };
    }
    case "audio": {
      const mimeType = normalizeMcpMimeType(block.mimeType);
      return {
        type: "text",
        text: `[audio omitted${mimeType ? `: ${mimeType}` : ""}]`,
      };
    }
    case "resource_link": {
      const uri = sanitizeMcpResourceUri(block.uri) ?? "[resource URI omitted]";
      const label = [block.title, block.name].find(
        (value): value is string => typeof value === "string" && value.trim().length > 0,
      );
      return {
        type: "text",
        text: typeof label === "string" ? `[${sanitizeMcpString(label)}] ${uri}` : uri,
      };
    }
    case "resource": {
      if (!isRecord(block.resource)) {
        return { type: "text", text: "[invalid MCP resource omitted]" };
      }
      const resource = block.resource;
      const uri = sanitizeMcpResourceUri(resource.uri);
      const mimeType = normalizeMcpMimeType(resource.mimeType);
      if (typeof resource.blob === "string") {
        return describeResource({ binary: true, mimeType, uri });
      }
      if (typeof resource.text === "string") {
        return { type: "text", text: sanitizeMcpString(resource.text) };
      }
      return describeResource({ binary: false, mimeType, uri });
    }
    default:
      return { type: "text", text: "[unsupported MCP content omitted]" };
  }
}

function serializedJsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

function projectMcpContentBlocksWithinBudget(
  blocks: readonly unknown[],
  aggregateBaseBytes: number,
): { content: McpAgentContentBlock[]; aggregateTruncated: boolean; usedBytes: number } {
  const projected = blocks
    .slice(0, MCP_CONTENT_MAX_BLOCKS)
    .map((block) => mcpContentBlockToAgentContent(block));
  let remainingTextBytes = MCP_TEXT_CONTENT_MAX_BYTES;
  let textTruncated = false;
  const textBounded: McpAgentContentBlock[] = [];
  for (const block of projected) {
    if (block.type !== "text") {
      textBounded.push(block);
      continue;
    }
    const available = Math.max(
      0,
      remainingTextBytes - Buffer.byteLength(MCP_TEXT_TRUNCATION_MARKER),
    );
    const text = truncateUtf8Prefix(block.text, available);
    remainingTextBytes -= Buffer.byteLength(text);
    if (text.length < block.text.length) {
      textBounded.push({ type: "text", text: `${text}${MCP_TEXT_TRUNCATION_MARKER}` });
      textTruncated = true;
      break;
    }
    textBounded.push(block);
  }

  const result: McpAgentContentBlock[] = [];
  let usedBytes = aggregateBaseBytes;
  let aggregateTruncated = false;
  const aggregateMarkerBytes =
    serializedJsonBytes({
      type: "text",
      text: MCP_RESULT_TRUNCATION_MARKER,
    }) + 1;
  for (const block of textBounded) {
    const blockBytes = serializedJsonBytes(block) + (result.length > 0 ? 1 : 0);
    if (usedBytes + blockBytes + aggregateMarkerBytes > MCP_RESULT_MAX_BYTES) {
      aggregateTruncated = true;
      continue;
    }
    result.push(block);
    usedBytes += blockBytes;
  }
  if (blocks.length > MCP_CONTENT_MAX_BLOCKS || textTruncated || aggregateTruncated) {
    if (aggregateTruncated) {
      const marker = { type: "text" as const, text: MCP_RESULT_TRUNCATION_MARKER };
      usedBytes += serializedJsonBytes(marker) + (result.length > 0 ? 1 : 0);
      result.push(marker);
    } else if (blocks.length > MCP_CONTENT_MAX_BLOCKS && !textTruncated) {
      const marker = {
        type: "text" as const,
        text: "[truncated: MCP content block count exceeded 200]",
      };
      if (result.length >= MCP_CONTENT_MAX_BLOCKS) {
        const index = MCP_CONTENT_MAX_BLOCKS - 1;
        const replaced = result[index];
        if (replaced) {
          usedBytes += serializedJsonBytes(marker) - serializedJsonBytes(replaced);
          result[index] = marker;
        }
      } else {
        usedBytes += serializedJsonBytes(marker) + (result.length > 0 ? 1 : 0);
        result.push(marker);
      }
    }
  }
  return { content: result, aggregateTruncated, usedBytes };
}

/** Projects ordered MCP blocks with count, text, and aggregate encoded-size limits. */
export function projectMcpContentBlocks(blocks: readonly unknown[]): McpAgentContentBlock[] {
  return projectMcpContentBlocksWithinBudget(blocks, Buffer.byteLength("[]")).content;
}

/** Projects a complete node-host MCP result under the shared encoded payload budget. */
export function projectMcpToolResultPayload(result: {
  content: readonly unknown[];
  structuredContent?: Record<string, unknown>;
}): { content: McpAgentContentBlock[]; structuredContent?: Record<string, unknown> } {
  const projected = projectMcpContentBlocksWithinBudget(
    result.content,
    Buffer.byteLength('{"content":[]}'),
  );
  const content = projected.content;
  let structuredContent: Record<string, unknown> | undefined;
  if (result.structuredContent) {
    const projectedStructuredContent = projectMcpJsonValue(result.structuredContent);
    const structuredBytes =
      Buffer.byteLength(',"structuredContent":') + serializedJsonBytes(projectedStructuredContent);
    const marker = { type: "text" as const, text: MCP_RESULT_TRUNCATION_MARKER };
    const markerBytes = serializedJsonBytes(marker) + (content.length > 0 ? 1 : 0);
    const reservedMarkerBytes = projected.aggregateTruncated ? 0 : markerBytes;
    if (
      isRecord(projectedStructuredContent) &&
      projected.usedBytes + structuredBytes + reservedMarkerBytes <= MCP_RESULT_MAX_BYTES
    ) {
      structuredContent = projectedStructuredContent;
    } else if (!projected.aggregateTruncated) {
      content.push(marker);
    }
  }
  return { content, ...(structuredContent ? { structuredContent } : {}) };
}
