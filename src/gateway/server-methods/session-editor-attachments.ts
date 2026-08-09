import path from "node:path";
import { decodedBase64Bytes } from "@openclaw/llm-core";
import {
  CHAT_ATTACHMENT_MAX_AGGREGATE_DECODED_BYTES,
  CHAT_ATTACHMENT_MAX_DECODED_BYTES_PER_ITEM,
  CHAT_ATTACHMENT_MAX_ENCODED_REQUEST_BYTES,
  CHAT_ATTACHMENT_MAX_ITEMS,
  estimateChatAttachmentRequestBytes,
} from "../../../packages/gateway-protocol/src/index.js";
import type {
  SessionEditorMediaRef,
  SessionMessageCutPreflightResult,
} from "../../config/sessions/session-accessor.js";
import { normalizeCanonicalInboundMediaUri } from "../../media/media-reference-projection.js";
import { parseInboundMediaUri } from "../../media/media-reference.js";
import { readMediaBuffer } from "../../media/store.js";

export type EditorAttachment = { mimeType: string; data: string };
type EditorAttachmentRestoreResult =
  | { status: "ready"; attachments: EditorAttachment[] }
  | { status: "failed"; reason: "invalid" | "limit" | "unavailable" };

class EditorAttachmentRestoreError extends Error {
  constructor(
    readonly reason: Extract<EditorAttachmentRestoreResult, { status: "failed" }>["reason"],
  ) {
    super(reason);
    this.name = "EditorAttachmentRestoreError";
  }
}

function attachmentDecodedBytes(attachment: EditorAttachment): number {
  const decodedBytes = decodedBase64Bytes(attachment.data);
  if (
    decodedBytes === undefined ||
    !/^(?:image|video)\/[\w.+-]+$/u.test(attachment.mimeType) ||
    decodedBytes > CHAT_ATTACHMENT_MAX_DECODED_BYTES_PER_ITEM
  ) {
    throw new EditorAttachmentRestoreError(
      decodedBytes !== undefined && decodedBytes > CHAT_ATTACHMENT_MAX_DECODED_BYTES_PER_ITEM
        ? "limit"
        : "invalid",
    );
  }
  return decodedBytes;
}

function assertEditorAttachmentBudget(
  attachments: readonly { attachment: EditorAttachment; decodedBytes: number }[],
  editorText: string | undefined,
): void {
  if (attachments.length > CHAT_ATTACHMENT_MAX_ITEMS) {
    throw new EditorAttachmentRestoreError("limit");
  }
  const descriptors = attachments.map(({ attachment, decodedBytes }) => ({
    decodedBytes,
    mimeType: attachment.mimeType,
  }));
  if (
    descriptors.reduce((total, entry) => total + entry.decodedBytes, 0) >
      CHAT_ATTACHMENT_MAX_AGGREGATE_DECODED_BYTES ||
    estimateChatAttachmentRequestBytes({ attachments: descriptors, message: editorText ?? "" }) >=
      CHAT_ATTACHMENT_MAX_ENCODED_REQUEST_BYTES
  ) {
    throw new EditorAttachmentRestoreError("limit");
  }
}

function resolveEditorMediaId(ref: SessionEditorMediaRef): { id: string; mimeType: string } {
  const mimeType = ref.contentType?.trim().toLowerCase();
  const mimeKind = mimeType?.startsWith("image/")
    ? "image"
    : mimeType?.startsWith("video/")
      ? "video"
      : undefined;
  if (!mimeType || !mimeKind || (ref.kind && ref.kind !== mimeKind)) {
    throw new EditorAttachmentRestoreError("invalid");
  }

  const canonicalUri = normalizeCanonicalInboundMediaUri(ref.url);
  if (mimeKind === "video") {
    if (
      !canonicalUri ||
      !ref.sourceId ||
      ref.sourceIndex === undefined ||
      parseInboundMediaUri(canonicalUri)?.id !== ref.sourceId
    ) {
      throw new EditorAttachmentRestoreError("invalid");
    }
    return { id: ref.sourceId, mimeType };
  }
  if (ref.url) {
    const parsed = canonicalUri ? parseInboundMediaUri(canonicalUri) : null;
    if (!parsed || (ref.sourceId && parsed.id !== ref.sourceId)) {
      throw new EditorAttachmentRestoreError("invalid");
    }
    return { id: parsed.id, mimeType };
  }

  // Shipped image transcripts predate canonical claim-check URLs. Preserve only
  // their exact inbound-store path shape; video is reference-only and never uses this path.
  const legacyPath = ref.path?.trim();
  if (
    !legacyPath ||
    legacyPath !== path.normalize(legacyPath) ||
    path.basename(path.dirname(legacyPath)) !== "inbound"
  ) {
    throw new EditorAttachmentRestoreError("invalid");
  }
  const id = path.basename(legacyPath);
  if (!id || id === "." || id === ".." || (ref.sourceId && ref.sourceId !== id)) {
    throw new EditorAttachmentRestoreError("invalid");
  }
  return { id, mimeType };
}

async function materializeEditorAttachments(
  preflight: Extract<SessionMessageCutPreflightResult, { status: "ready" }>,
): Promise<EditorAttachment[]> {
  const existing = (preflight.editorAttachments ?? []).map((attachment) => ({
    attachment,
    decodedBytes: attachmentDecodedBytes(attachment),
  }));
  const seen = new Map<string, string>();
  const refs: Array<{ id: string; mimeType: string; sizeBytes?: number }> = [];
  for (const ref of preflight.editorMediaRefs ?? []) {
    const { id, mimeType } = resolveEditorMediaId(ref);
    const seenMime = seen.get(id);
    if (seenMime) {
      if (seenMime !== mimeType) {
        throw new EditorAttachmentRestoreError("invalid");
      }
      continue;
    }
    seen.set(id, mimeType);
    if (
      ref.sizeBytes !== undefined &&
      (!Number.isSafeInteger(ref.sizeBytes) ||
        ref.sizeBytes <= 0 ||
        ref.sizeBytes > CHAT_ATTACHMENT_MAX_DECODED_BYTES_PER_ITEM)
    ) {
      throw new EditorAttachmentRestoreError(
        ref.sizeBytes > CHAT_ATTACHMENT_MAX_DECODED_BYTES_PER_ITEM ? "limit" : "invalid",
      );
    }
    refs.push({
      id,
      mimeType,
      ...(ref.sizeBytes !== undefined ? { sizeBytes: ref.sizeBytes } : {}),
    });
  }
  if (existing.length + refs.length > CHAT_ATTACHMENT_MAX_ITEMS) {
    throw new EditorAttachmentRestoreError("limit");
  }
  const knownAggregateBytes =
    existing.reduce((total, entry) => total + entry.decodedBytes, 0) +
    refs.reduce((total, ref) => total + (ref.sizeBytes ?? 0), 0);
  if (knownAggregateBytes > CHAT_ATTACHMENT_MAX_AGGREGATE_DECODED_BYTES) {
    throw new EditorAttachmentRestoreError("limit");
  }

  const restored = await Promise.all(
    refs.map(async (ref) => {
      let media: Awaited<ReturnType<typeof readMediaBuffer>>;
      try {
        media = await readMediaBuffer(
          ref.id,
          "inbound",
          CHAT_ATTACHMENT_MAX_DECODED_BYTES_PER_ITEM,
        );
      } catch {
        throw new EditorAttachmentRestoreError("unavailable");
      }
      if (ref.sizeBytes !== undefined && media.size !== ref.sizeBytes) {
        throw new EditorAttachmentRestoreError("unavailable");
      }
      if (!Number.isSafeInteger(media.size) || media.size <= 0) {
        throw new EditorAttachmentRestoreError("invalid");
      }
      return {
        attachment: { mimeType: ref.mimeType, data: media.buffer.toString("base64") },
        decodedBytes: media.size,
      };
    }),
  );
  const attachments = [...existing, ...restored];
  assertEditorAttachmentBudget(attachments, preflight.editorText);
  return attachments.map((entry) => entry.attachment);
}

export async function restoreSessionEditorAttachments(
  preflight: Extract<SessionMessageCutPreflightResult, { status: "ready" }>,
): Promise<EditorAttachmentRestoreResult> {
  try {
    return { status: "ready", attachments: await materializeEditorAttachments(preflight) };
  } catch (error) {
    return {
      status: "failed",
      reason: error instanceof EditorAttachmentRestoreError ? error.reason : "unavailable",
    };
  }
}
