// Control UI chat module implements attachment payload store behavior.
import {
  CHAT_ATTACHMENT_MAX_AGGREGATE_DECODED_BYTES,
  CHAT_ATTACHMENT_MAX_DECODED_BYTES_PER_ITEM,
  CHAT_ATTACHMENT_MAX_ENCODED_REQUEST_BYTES,
  CHAT_ATTACHMENT_MAX_ITEMS,
  estimateChatAttachmentRequestBytes,
} from "@openclaw/gateway-protocol";
import { canonicalizeBase64, estimateBase64DecodedBytes } from "@openclaw/media-core/base64";
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";

type AttachmentPayload = {
  dataUrl?: string;
  previewUrl?: string;
};

const payloads = new Map<string, AttachmentPayload>();

function createObjectUrl(file: File): string | undefined {
  if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
    return undefined;
  }
  return URL.createObjectURL(file);
}

function revokeObjectUrl(url: string | undefined): void {
  if (!url || typeof URL === "undefined" || typeof URL.revokeObjectURL !== "function") {
    return;
  }
  URL.revokeObjectURL(url);
}

export function registerChatAttachmentPayload(params: {
  attachment: ChatAttachment;
  dataUrl: string;
  file: File;
}): ChatAttachment {
  const previous = payloads.get(params.attachment.id);
  revokeObjectUrl(previous?.previewUrl);
  const objectUrl = createObjectUrl(params.file);
  const previewUrl = objectUrl ?? params.attachment.previewUrl;
  payloads.set(params.attachment.id, {
    dataUrl: params.dataUrl,
    ...(previewUrl ? { previewUrl } : {}),
  });
  return {
    ...params.attachment,
    ...(previewUrl ? { previewUrl } : {}),
  };
}

export function getChatAttachmentDataUrl(attachment: ChatAttachment): string | null {
  return attachment.dataUrl ?? payloads.get(attachment.id)?.dataUrl ?? null;
}

export function getChatAttachmentPreviewUrl(attachment: ChatAttachment): string | null {
  return (
    attachment.previewUrl ?? payloads.get(attachment.id)?.previewUrl ?? attachment.dataUrl ?? null
  );
}

function cloneChatAttachmentMetadata(attachment: ChatAttachment): ChatAttachment {
  const { dataUrl: _dataUrl, ...metadata } = attachment;
  return metadata;
}

export function cloneChatAttachmentsMetadata(
  attachments: readonly ChatAttachment[],
): ChatAttachment[] {
  return attachments.map(cloneChatAttachmentMetadata);
}

export function releaseChatAttachmentPayload(id: string): void {
  const payload = payloads.get(id);
  if (!payload) {
    return;
  }
  revokeObjectUrl(payload.previewUrl);
  payloads.delete(id);
}

export function releaseChatAttachmentPayloads(attachments: readonly ChatAttachment[] = []): void {
  for (const attachment of attachments) {
    releaseChatAttachmentPayload(attachment.id);
  }
}

export function generateAttachmentId(): string {
  return `att-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

// Rewind/fork is all-or-nothing: validate the complete Gateway response before
// releasing the current composer's payloads or object URLs.
const RESTORED_MODEL_MEDIA_MIME = /^(?:image|video)\/[\w.+-]+$/u;

export function replaceChatAttachmentsFromEditor(
  current: readonly ChatAttachment[],
  restored: readonly { mimeType: string; data: string }[] = [],
): ChatAttachment[] {
  if (restored.length > CHAT_ATTACHMENT_MAX_ITEMS) {
    throw new Error("Restored attachments exceed the editor attachment count limit");
  }
  const decoded = restored.map(({ mimeType, data }) => {
    const canonical = canonicalizeBase64(data);
    const decodedBytes = canonical ? estimateBase64DecodedBytes(canonical) : undefined;
    if (
      !RESTORED_MODEL_MEDIA_MIME.test(mimeType) ||
      canonical !== data ||
      decodedBytes === undefined ||
      decodedBytes > CHAT_ATTACHMENT_MAX_DECODED_BYTES_PER_ITEM
    ) {
      throw new Error("Gateway returned an invalid restored attachment");
    }
    return { data: canonical, decodedBytes, mimeType };
  });
  if (
    decoded.reduce((total, attachment) => total + attachment.decodedBytes, 0) >
      CHAT_ATTACHMENT_MAX_AGGREGATE_DECODED_BYTES ||
    estimateChatAttachmentRequestBytes({ attachments: decoded, message: "" }) >=
      CHAT_ATTACHMENT_MAX_ENCODED_REQUEST_BYTES
  ) {
    throw new Error("Restored attachments exceed the editor size limit");
  }
  const next = decoded.map(({ mimeType, data }) => ({
    id: generateAttachmentId(),
    mimeType,
    dataUrl: `data:${mimeType};base64,${data}`,
  }));
  releaseChatAttachmentPayloads(current);
  return next;
}

function discardChatAttachmentDataUrl(id: string): void {
  const payload = payloads.get(id);
  if (!payload) {
    return;
  }
  if (payload.previewUrl) {
    payloads.set(id, { previewUrl: payload.previewUrl });
    return;
  }
  payloads.delete(id);
}

export function discardChatAttachmentDataUrls(attachments: readonly ChatAttachment[] = []): void {
  for (const attachment of attachments) {
    discardChatAttachmentDataUrl(attachment.id);
  }
}
