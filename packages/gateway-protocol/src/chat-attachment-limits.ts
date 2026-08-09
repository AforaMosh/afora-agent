/** Frame-safe v1 limits shared by Gateway admission and browser acquisition. */
export const CHAT_ATTACHMENT_MAX_ITEMS = 4;
export const CHAT_ATTACHMENT_MAX_DECODED_BYTES_PER_ITEM = 8 * 1024 * 1024;
export const CHAT_ATTACHMENT_MAX_AGGREGATE_DECODED_BYTES = 12 * 1024 * 1024;
// Leaves room below Google's exclusive 20,000,000-byte inline request limit
// and the Gateway's 25 MiB WebSocket cap for text and envelope metadata.
export const CHAT_ATTACHMENT_MAX_ENCODED_REQUEST_BYTES = 18 * 1024 * 1024;

export type ChatAttachmentLimits = {
  maxItems: number;
  maxBytes: number;
  maxImageBytes: number;
  maxAggregateDecodedBytes: number;
  maxEncodedRequestBytes: number;
};

export type ChatAttachmentSizeDescriptor = {
  decodedBytes: number;
  fileName?: string;
  mimeType: string;
};

const CHAT_SEND_FRAME_ID = "00000000-0000-4000-8000-000000000000";
const ATTACHMENTS_MARKER = "__openclaw_attachment_list__";
const ENCODED_ATTACHMENTS_MARKER_BYTES = ATTACHMENTS_MARKER.length + 2;

/** Exact padded-base64 length for a decoded byte count. */
export function encodedBase64Length(decodedBytes: number): number {
  return Math.ceil(decodedBytes / 3) * 4;
}

/**
 * Conservatively project the Control UI chat.send envelope before file bytes are read.
 * Base64 is ASCII, so its encoded length can be added without allocating it.
 */
export function estimateChatAttachmentRequestBytes(params: {
  attachments: readonly ChatAttachmentSizeDescriptor[];
  message: string;
}): number {
  const frameWithoutAttachments = {
    type: "req",
    id: CHAT_SEND_FRAME_ID,
    method: "chat.send",
    params: {
      sessionKey: "",
      message: params.message,
      deliver: false,
      idempotencyKey: CHAT_SEND_FRAME_ID,
      attachments: ATTACHMENTS_MARKER,
    },
  };
  let bytes =
    new TextEncoder().encode(JSON.stringify(frameWithoutAttachments)).byteLength -
    ENCODED_ATTACHMENTS_MARKER_BYTES +
    2;
  for (const [index, attachment] of params.attachments.entries()) {
    if (index > 0) {
      bytes += 1;
    }
    const type = attachment.mimeType.startsWith("image/") ? "image" : "file";
    // Braces, keys, separators, and the empty content string. The Base64 payload
    // is safe ASCII and replaces only the empty string's interior.
    bytes += new TextEncoder().encode(
      JSON.stringify({
        type,
        mimeType: attachment.mimeType,
        ...(attachment.fileName ? { fileName: attachment.fileName } : {}),
        content: "",
      }),
    ).byteLength;
    bytes += encodedBase64Length(attachment.decodedBytes);
  }
  // The real route/session fields replace the empty session key. Keep a bounded
  // reserve while the final send path checks the fully serialized envelope.
  return bytes + 64 * 1024;
}
