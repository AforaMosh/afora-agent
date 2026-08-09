// Attachment policy tests guard the limits advertised on `hello-ok` against the
// frame-safe ceilings the parser actually enforces.
import { MAX_IMAGE_BYTES } from "@openclaw/media-core/constants";
import { describe, expect, it } from "vitest";
import {
  CHAT_ATTACHMENT_MAX_AGGREGATE_DECODED_BYTES,
  CHAT_ATTACHMENT_MAX_DECODED_BYTES_PER_ITEM,
  CHAT_ATTACHMENT_MAX_ENCODED_REQUEST_BYTES,
  CHAT_ATTACHMENT_MAX_ITEMS,
} from "../../packages/gateway-protocol/src/chat-attachment-limits.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveChatAttachmentPolicy } from "./chat-attachment-policy.js";

const MB = 1024 * 1024;

const cfgWithMediaMaxMb = (value: unknown): OpenClawConfig =>
  ({ agents: { defaults: { mediaMaxMb: value } } }) as unknown as OpenClawConfig;

describe("resolveChatAttachmentPolicy", () => {
  it("honours a configured agents.defaults.mediaMaxMb", () => {
    expect(resolveChatAttachmentPolicy(cfgWithMediaMaxMb(1)).maxBytes).toBe(MB);
    expect(resolveChatAttachmentPolicy(cfgWithMediaMaxMb(2)).maxBytes).toBe(2 * MB);
  });

  it("falls back to the default ceiling when unset", () => {
    expect(resolveChatAttachmentPolicy({} as OpenClawConfig).maxBytes).toBe(
      CHAT_ATTACHMENT_MAX_DECODED_BYTES_PER_ITEM,
    );
    expect(resolveChatAttachmentPolicy({ agents: {} } as unknown as OpenClawConfig).maxBytes).toBe(
      CHAT_ATTACHMENT_MAX_DECODED_BYTES_PER_ITEM,
    );
  });

  it("rejects non-positive, non-finite, or non-number values", () => {
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, "50", null, undefined]) {
      expect(resolveChatAttachmentPolicy(cfgWithMediaMaxMb(bad)).maxBytes).toBe(
        CHAT_ATTACHMENT_MAX_DECODED_BYTES_PER_ITEM,
      );
    }
  });

  it("never floors a legal sub-byte mediaMaxMb to zero", () => {
    expect(resolveChatAttachmentPolicy(cfgWithMediaMaxMb(0.0000001)).maxBytes).toBe(1);
  });

  it("keeps an enormous mediaMaxMb representable instead of overflowing", () => {
    expect(resolveChatAttachmentPolicy(cfgWithMediaMaxMb(1e308)).maxBytes).toBe(
      CHAT_ATTACHMENT_MAX_DECODED_BYTES_PER_ITEM,
    );
  });

  it("advertises the conservative frame-safe ceiling with the image hydration cap applied", () => {
    expect(resolveChatAttachmentPolicy(cfgWithMediaMaxMb(20))).toEqual({
      maxBytes: CHAT_ATTACHMENT_MAX_DECODED_BYTES_PER_ITEM,
      maxImageBytes: MAX_IMAGE_BYTES,
      maxItems: CHAT_ATTACHMENT_MAX_ITEMS,
      maxAggregateDecodedBytes: CHAT_ATTACHMENT_MAX_AGGREGATE_DECODED_BYTES,
      maxEncodedRequestBytes: CHAT_ATTACHMENT_MAX_ENCODED_REQUEST_BYTES,
    });
  });

  it("clamps maxImageBytes to the configured ceiling when it is the smaller limit", () => {
    expect(resolveChatAttachmentPolicy(cfgWithMediaMaxMb(1))).toEqual({
      maxBytes: MB,
      maxImageBytes: MB,
      maxItems: CHAT_ATTACHMENT_MAX_ITEMS,
      maxAggregateDecodedBytes: 4 * MB,
      maxEncodedRequestBytes: CHAT_ATTACHMENT_MAX_ENCODED_REQUEST_BYTES,
    });
  });

  it("keeps both ceilings positive so the hello-ok schema stays satisfiable", () => {
    const policy = resolveChatAttachmentPolicy(cfgWithMediaMaxMb(0.0000001));
    expect(policy.maxBytes).toBeGreaterThanOrEqual(1);
    expect(policy.maxImageBytes).toBeGreaterThanOrEqual(1);
  });
});
