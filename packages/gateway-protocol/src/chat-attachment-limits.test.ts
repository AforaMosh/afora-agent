import { describe, expect, it } from "vitest";
import {
  encodedBase64Length,
  estimateChatAttachmentRequestBytes,
} from "./chat-attachment-limits.js";

describe("chat attachment request estimation", () => {
  it("uses padded Base64 lengths without materializing payloads", () => {
    expect(encodedBase64Length(1)).toBe(4);
    expect(encodedBase64Length(3)).toBe(4);
    expect(encodedBase64Length(4)).toBe(8);
  });

  it("accounts for message, attachment metadata, payload size, and route reserve", () => {
    const small = estimateChatAttachmentRequestBytes({
      message: "x",
      attachments: [{ decodedBytes: 3, mimeType: "video/mp4", fileName: "a.mp4" }],
    });
    const larger = estimateChatAttachmentRequestBytes({
      message: "x".repeat(10),
      attachments: [{ decodedBytes: 4, mimeType: "video/mp4", fileName: "longer.mp4" }],
    });
    expect(larger).toBeGreaterThan(small);
  });
});
