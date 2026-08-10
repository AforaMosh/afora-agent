import path from "node:path";
import { asOptionalRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import {
  CHAT_ATTACHMENT_MAX_DECODED_BYTES_PER_ITEM,
  CHAT_ATTACHMENT_MAX_ITEMS,
  encodedBase64Length,
} from "../../../packages/gateway-protocol/src/chat-attachment-limits.js";
import {
  readPersistedMediaBlockFactIndexes,
  readPersistedMediaFacts,
} from "../../media/media-facts.js";
import { normalizeCanonicalInboundMediaUri } from "../../media/media-reference-projection.js";
import { parseInboundMediaUri } from "../../media/media-reference.js";
import type { SessionEditorMediaRef } from "./session-accessor.types.js";

type ResolvedEditorMediaRef =
  | { kind: "image"; id: string; factIndex: number; ref: SessionEditorMediaRef }
  | { kind: "video"; ref: SessionEditorMediaRef };

const EDITOR_ATTACHMENT_MAX_BASE64_CHARS = encodedBase64Length(
  CHAT_ATTACHMENT_MAX_DECODED_BYTES_PER_ITEM,
);
const INVALID_EDITOR_ATTACHMENT_FIELD = "!";
const EDITOR_ATTACHMENT_COUNT_OVERFLOW_SIGNAL = { mimeType: "image/png", data: "AA==" };

export function extractEditorAttachments(
  content: unknown,
): Array<{ mimeType: string; data: string }> | undefined {
  if (!Array.isArray(content)) {
    return undefined;
  }
  const attachments: Array<{ mimeType: string; data: string }> = [];
  for (const block of content) {
    const record = asRecord(block);
    if (record?.type !== "image") {
      continue;
    }
    if (attachments.length === CHAT_ATTACHMENT_MAX_ITEMS) {
      // Do not retain or inspect another payload. One tiny valid entry makes the Gateway's
      // existing item-count validator fail with limit precedence over malformed item fields.
      attachments.push(EDITOR_ATTACHMENT_COUNT_OVERFLOW_SIGNAL);
      break;
    }
    // The Gateway owns strict size/MIME/base64 validation before mutation. Keep
    // bounded malformed blocks visible to that preflight instead of silently dropping them.
    const mimeType = typeof record.mimeType === "string" ? record.mimeType : "";
    const data = typeof record.data === "string" ? record.data : "";
    attachments.push({
      mimeType:
        mimeType.length <= EDITOR_ATTACHMENT_MAX_BASE64_CHARS
          ? mimeType
          : INVALID_EDITOR_ATTACHMENT_FIELD,
      // Do not copy or truncate an oversized transcript payload merely to reject it later.
      data:
        data.length <= EDITOR_ATTACHMENT_MAX_BASE64_CHARS ? data : INVALID_EDITOR_ATTACHMENT_FIELD,
    });
  }
  return attachments.length > 0 ? attachments : undefined;
}

export function extractEditorMediaRefs(
  message: Record<string, unknown>,
): SessionEditorMediaRef[] | undefined {
  const refs = (readPersistedMediaFacts(message) ?? []).flatMap(
    (fact, factIndex): ResolvedEditorMediaRef[] => {
      const normalizedContentType = fact.contentType?.trim().toLowerCase();
      const contentKind = normalizedContentType?.startsWith("image/")
        ? "image"
        : normalizedContentType?.startsWith("video/")
          ? "video"
          : undefined;
      const kind = fact.kind === "image" || fact.kind === "video" ? fact.kind : contentKind;
      if (!kind) {
        return [];
      }
      let editorPath = fact.path;
      let editorUrl = fact.url;
      let imageId: string | undefined;
      if (kind === "image") {
        // Editor refs are managed-store claims, not a second copy of persisted media metadata.
        // Filtering here keeps unrelated historical facts from blocking a text rewind or fork.
        if (!normalizedContentType?.startsWith("image/")) {
          return [];
        }
        const canonicalUrl = normalizeCanonicalInboundMediaUri(fact.url);
        if (canonicalUrl) {
          const id = parseInboundMediaUri(canonicalUrl)?.id;
          if (!id || (fact.sourceId && fact.sourceId !== id)) {
            return [];
          }
          editorPath = undefined;
          editorUrl = canonicalUrl;
          imageId = id;
        } else {
          const legacyPath = fact.path;
          const id = legacyPath ? path.basename(legacyPath) : "";
          if (
            !legacyPath ||
            legacyPath !== path.normalize(legacyPath) ||
            path.basename(path.dirname(legacyPath)) !== "inbound" ||
            !id ||
            id === "." ||
            id === ".." ||
            id.includes("\\") ||
            id.includes("\0") ||
            (fact.sourceId && fact.sourceId !== id)
          ) {
            return [];
          }
          editorUrl = undefined;
          imageId = id;
        }
      }
      const canonicalVideoUrl =
        kind === "video" ? normalizeCanonicalInboundMediaUri(fact.url) : null;
      if (
        kind === "video" &&
        (!canonicalVideoUrl ||
          !fact.sourceId ||
          fact.sourceIndex === undefined ||
          !normalizedContentType?.startsWith("video/") ||
          parseInboundMediaUri(canonicalVideoUrl)?.id !== fact.sourceId)
      ) {
        return [];
      }
      const ref: SessionEditorMediaRef = {
        kind,
        ...(fact.sourceId ? { sourceId: fact.sourceId } : {}),
        ...(fact.sourceIndex !== undefined ? { sourceIndex: fact.sourceIndex } : {}),
        ...(editorPath ? { path: editorPath } : {}),
        ...(canonicalVideoUrl ? { url: canonicalVideoUrl } : editorUrl ? { url: editorUrl } : {}),
        ...(fact.contentType ? { contentType: fact.contentType } : {}),
        ...(fact.sizeBytes !== undefined ? { sizeBytes: fact.sizeBytes } : {}),
      };
      return kind === "image" && imageId
        ? [{ kind, id: imageId, factIndex, ref }]
        : [{ kind: "video", ref }];
    },
  );
  const content = Array.isArray(message.content) ? message.content : [];
  const mediaBlocks = content.flatMap((block) => {
    const record = asRecord(block);
    return record?.type === "image" || record?.type === "video" ? [record] : [];
  });
  const persistedIndexes = readPersistedMediaBlockFactIndexes(message);
  const mappedInlineImageFactIndexes = new Set(
    persistedIndexes?.length === mediaBlocks.length
      ? mediaBlocks.flatMap((block, index) => {
          const factIndex = persistedIndexes[index];
          return block.type === "image" && typeof factIndex === "number" ? [factIndex] : [];
        })
      : [],
  );
  // The producer-authored block mapping is the only authority that an inline image and
  // durable facts are the same attachment. Filtering by managed ID also removes aliases.
  const inlineImageIds = new Set(
    refs.flatMap((entry) =>
      entry.kind === "image" && mappedInlineImageFactIndexes.has(entry.factIndex) ? [entry.id] : [],
    ),
  );
  const editorRefs = refs.flatMap((entry) =>
    entry.kind === "image" && inlineImageIds.has(entry.id) ? [] : [entry.ref],
  );
  return editorRefs.length > 0 ? editorRefs : undefined;
}
