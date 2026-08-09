// @vitest-environment node
import { estimateBase64DecodedBytes } from "@openclaw/media-core/base64";
import { describe, expect, it, vi } from "vitest";
import { estimateChatAttachmentRequestBytes } from "../../../../packages/gateway-protocol/src/chat-attachment-limits.ts";
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import type { ChatState } from "./chat-history.ts";
import { requestChatSend } from "./chat-send-request.ts";

const attachmentContent = "dmlkZW8=";
const attachment: ChatAttachment = {
  id: "attachment-1",
  dataUrl: `data:video/mp4;base64,${attachmentContent}`,
  mimeType: "video/mp4",
  fileName: "clip.mp4",
};

function createState(maxEncodedRequestBytes: number, request: ReturnType<typeof vi.fn>): ChatState {
  return {
    client: { request },
    connected: true,
    connectionEpoch: 0,
    sessionKey: "agent:main:main",
    hello: { policy: { attachments: { maxEncodedRequestBytes } } },
  } as unknown as ChatState;
}

describe("chat.send encoded frame admission", () => {
  it("conservatively rejects an attachment at the exclusive limit", async () => {
    const message = "inspect this";
    const wireParams = {
      sessionKey: "agent:main:main",
      message,
      deliver: false,
      idempotencyKey: "11111111-1111-4111-8111-111111111111",
      attachments: [
        {
          type: "file",
          mimeType: "video/mp4",
          fileName: "clip.mp4",
          content: attachmentContent,
        },
      ],
    };
    const estimated = estimateChatAttachmentRequestBytes({
      message,
      attachments: [
        {
          decodedBytes: estimateBase64DecodedBytes(attachmentContent),
          fileName: attachment.fileName,
          mimeType: attachment.mimeType,
        },
      ],
    });
    const exact = new TextEncoder().encode(
      JSON.stringify({ type: "req", id: "x".repeat(36), method: "chat.send", params: wireParams }),
    ).byteLength;
    const request = vi.fn().mockResolvedValue({ runId: "run-1", status: "started" });

    expect(estimated).toBeGreaterThan(exact);
    await expect(
      requestChatSend(createState(estimated, request), {
        message,
        attachments: [attachment],
        runId: "run-1",
      }),
    ).rejects.toThrow(/encoded Gateway request limit/u);
    expect(request).not.toHaveBeenCalled();

    await expect(
      requestChatSend(createState(estimated + 1, request), {
        message,
        attachments: [attachment],
        runId: "run-1",
      }),
    ).resolves.toEqual({ runId: "run-1", status: "started" });
    expect(request).toHaveBeenCalledOnce();
  });
});
