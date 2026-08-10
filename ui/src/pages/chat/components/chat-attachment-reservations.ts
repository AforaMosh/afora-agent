import { canonicalizeBase64, estimateBase64DecodedBytes } from "@openclaw/media-core/base64";
import { MAX_IMAGE_BYTES } from "@openclaw/media-core/constants";
import {
  CHAT_ATTACHMENT_MAX_AGGREGATE_DECODED_BYTES,
  CHAT_ATTACHMENT_MAX_DECODED_BYTES_PER_ITEM,
  CHAT_ATTACHMENT_MAX_ENCODED_REQUEST_BYTES,
  CHAT_ATTACHMENT_MAX_ITEMS,
  estimateChatAttachmentRequestBytes,
  type ChatAttachmentLimits,
  type ChatAttachmentSizeDescriptor,
} from "../../../../../packages/gateway-protocol/src/chat-attachment-limits.ts";
import { t } from "../../../i18n/index.ts";
import type { ChatAttachment } from "../../../lib/chat/chat-types.ts";
import { getChatAttachmentDataUrl } from "../attachment-payload-store.ts";

export type ChatAttachmentReservationProps = {
  attachments?: ChatAttachment[];
  getAttachments?: () => ChatAttachment[];
  draft?: string;
  getDraft?: () => string;
  onAttachmentError?: (message: string) => void;
  readSignal?: AbortSignal;
  attachmentLimits?: Partial<ChatAttachmentLimits>;
};

const DEFAULT_ATTACHMENT_LIMITS: ChatAttachmentLimits = {
  maxItems: CHAT_ATTACHMENT_MAX_ITEMS,
  maxBytes: CHAT_ATTACHMENT_MAX_DECODED_BYTES_PER_ITEM,
  maxImageBytes: MAX_IMAGE_BYTES,
  maxAggregateDecodedBytes: CHAT_ATTACHMENT_MAX_AGGREGATE_DECODED_BYTES,
  maxEncodedRequestBytes: CHAT_ATTACHMENT_MAX_ENCODED_REQUEST_BYTES,
};
const pendingAttachmentReservations = new WeakMap<AbortSignal, ChatAttachmentSizeDescriptor[]>();

function conservativeLimit(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.min(value, fallback)
    : fallback;
}

function resolveAttachmentLimits(limits?: Partial<ChatAttachmentLimits>): ChatAttachmentLimits {
  return {
    maxItems: conservativeLimit(limits?.maxItems, DEFAULT_ATTACHMENT_LIMITS.maxItems),
    maxBytes: conservativeLimit(limits?.maxBytes, DEFAULT_ATTACHMENT_LIMITS.maxBytes),
    maxImageBytes: conservativeLimit(
      limits?.maxImageBytes,
      DEFAULT_ATTACHMENT_LIMITS.maxImageBytes,
    ),
    maxAggregateDecodedBytes: conservativeLimit(
      limits?.maxAggregateDecodedBytes,
      DEFAULT_ATTACHMENT_LIMITS.maxAggregateDecodedBytes,
    ),
    maxEncodedRequestBytes: conservativeLimit(
      limits?.maxEncodedRequestBytes,
      DEFAULT_ATTACHMENT_LIMITS.maxEncodedRequestBytes,
    ),
  };
}

export function currentChatAttachments(props: ChatAttachmentReservationProps): ChatAttachment[] {
  return props.getAttachments?.() ?? props.attachments ?? [];
}

function decodedDataUrlBytes(dataUrl: string): number | undefined {
  const source = /^data:[^;]+;base64,(.*)$/u.exec(dataUrl)?.[1];
  if (!source) {
    return undefined;
  }
  const canonical = canonicalizeBase64(source);
  return canonical === source ? estimateBase64DecodedBytes(canonical) : undefined;
}

function attachmentSizeDescriptor(attachment: ChatAttachment): ChatAttachmentSizeDescriptor {
  const dataUrl = getChatAttachmentDataUrl(attachment);
  const decodedBytes = attachment.sizeBytes ?? (dataUrl ? decodedDataUrlBytes(dataUrl) : undefined);
  return {
    decodedBytes: decodedBytes ?? 0,
    fileName: attachment.fileName,
    mimeType: attachment.mimeType,
  };
}

function formatMiB(bytes: number): string {
  return `${bytes / (1024 * 1024)} MiB`;
}

export function reserveAttachmentFiles(
  files: readonly File[],
  props: ChatAttachmentReservationProps,
): ChatAttachmentSizeDescriptor[] | undefined {
  const limits = resolveAttachmentLimits(props.attachmentLimits);
  const existing = currentChatAttachments(props).map(attachmentSizeDescriptor);
  const pending = props.readSignal
    ? (pendingAttachmentReservations.get(props.readSignal) ?? [])
    : [];
  const incoming = files.map((file) => ({
    decodedBytes: file.size,
    fileName: file.name || undefined,
    mimeType: file.type || "application/octet-stream",
  }));
  const combined = [...existing, ...pending, ...incoming];
  if (combined.length > limits.maxItems) {
    props.onAttachmentError?.(t("chat.attachments.tooMany", { count: String(limits.maxItems) }));
    return undefined;
  }
  const oversized = combined.find(
    (attachment) =>
      attachment.decodedBytes >
      (attachment.mimeType.startsWith("image/") ? limits.maxImageBytes : limits.maxBytes),
  );
  if (oversized) {
    const maxBytes = oversized.mimeType.startsWith("image/")
      ? limits.maxImageBytes
      : limits.maxBytes;
    props.onAttachmentError?.(
      t("chat.attachments.fileTooLarge", {
        file: oversized.fileName ?? t("chat.attachments.attachedFile"),
        limit: formatMiB(maxBytes),
      }),
    );
    return undefined;
  }
  const aggregateBytes = combined.reduce((total, attachment) => total + attachment.decodedBytes, 0);
  if (aggregateBytes > limits.maxAggregateDecodedBytes) {
    props.onAttachmentError?.(
      t("chat.attachments.totalTooLarge", {
        limit: formatMiB(limits.maxAggregateDecodedBytes),
      }),
    );
    return undefined;
  }
  const encodedRequestBytes = estimateChatAttachmentRequestBytes({
    attachments: combined,
    message: props.getDraft?.() ?? props.draft ?? "",
  });
  if (encodedRequestBytes >= limits.maxEncodedRequestBytes) {
    props.onAttachmentError?.(
      t("chat.attachments.requestTooLarge", {
        limit: formatMiB(limits.maxEncodedRequestBytes),
      }),
    );
    return undefined;
  }
  if (props.readSignal) {
    pendingAttachmentReservations.set(props.readSignal, [...pending, ...incoming]);
  }
  return incoming;
}

export function releaseAttachmentReservation(
  reservation: readonly ChatAttachmentSizeDescriptor[],
  readSignal?: AbortSignal,
): void {
  if (!readSignal) {
    return;
  }
  const released = new Set(reservation);
  const remaining = (pendingAttachmentReservations.get(readSignal) ?? []).filter(
    (entry) => !released.has(entry),
  );
  if (remaining.length > 0) {
    pendingAttachmentReservations.set(readSignal, remaining);
  } else {
    pendingAttachmentReservations.delete(readSignal);
  }
}
