// Connection-level chat attachment ceilings shared by the parser and the
// `hello-ok` handshake. Kept out of chat-attachments.ts so the handshake path
// does not pull the media probe/store graph in just to read two numbers.
import { MAX_IMAGE_BYTES } from "@openclaw/media-core/constants";
import {
  CHAT_ATTACHMENT_MAX_AGGREGATE_DECODED_BYTES,
  CHAT_ATTACHMENT_MAX_DECODED_BYTES_PER_ITEM,
  CHAT_ATTACHMENT_MAX_ENCODED_REQUEST_BYTES,
  CHAT_ATTACHMENT_MAX_ITEMS,
  type ChatAttachmentLimits,
} from "../../packages/gateway-protocol/src/chat-attachment-limits.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const DEFAULT_CHAT_ATTACHMENT_MAX_MB = 20;

/** Resolve the maximum decoded attachment size accepted for chat inputs. */
function resolveChatAttachmentMaxBytes(cfg: OpenClawConfig): number {
  const configured = cfg.agents?.defaults?.mediaMaxMb;
  const mb =
    typeof configured === "number" && Number.isFinite(configured) && configured > 0
      ? configured
      : DEFAULT_CHAT_ATTACHMENT_MAX_MB;
  // mediaMaxMb only has to be positive, so a sub-byte value would floor to 0 and
  // a huge one overflows to Infinity, which serializes as null on the handshake
  // frame and fails its integer schema. Both ends have to stay representable.
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(1, Math.floor(mb * 1024 * 1024)));
}

/**
 * Resolve the frame-safe ceilings every chat attachment faces regardless of
 * entrypoint or model. A smaller configured media ceiling remains authoritative.
 */
export function resolveChatAttachmentPolicy(cfg: OpenClawConfig): ChatAttachmentLimits {
  const maxBytes = Math.min(
    resolveChatAttachmentMaxBytes(cfg),
    CHAT_ATTACHMENT_MAX_DECODED_BYTES_PER_ITEM,
  );
  return {
    maxBytes,
    maxImageBytes: Math.min(maxBytes, MAX_IMAGE_BYTES),
    maxItems: CHAT_ATTACHMENT_MAX_ITEMS,
    maxAggregateDecodedBytes: Math.min(
      CHAT_ATTACHMENT_MAX_AGGREGATE_DECODED_BYTES,
      maxBytes * CHAT_ATTACHMENT_MAX_ITEMS,
    ),
    maxEncodedRequestBytes: CHAT_ATTACHMENT_MAX_ENCODED_REQUEST_BYTES,
  };
}
