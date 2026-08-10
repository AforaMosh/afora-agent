import { castAgentMessage } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it } from "vitest";
import {
  createUserTurnTranscriptRecorder,
  mergePreparedUserTurnMessageForRuntime,
} from "./user-turn-transcript.js";
import { createTestUserTurnTranscriptTarget } from "./user-turn-transcript.test-support.js";

describe("native media user turn runtime merging", () => {
  const target = createTestUserTurnTranscriptTarget();

  it.each([
    {
      name: "image",
      content: [
        { type: "text", text: "canonical media caption" },
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
      ],
    },
    {
      name: "video",
      content: [
        { type: "text", text: "canonical media caption" },
        { type: "video", data: "dmlkZW8=", mimeType: "video/mp4" },
      ],
    },
    {
      name: "interleaved image and repeated video",
      content: [
        { type: "text", text: "before image" },
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
        { type: "text", text: "between media" },
        { type: "video", data: "dmlkZW8=", mimeType: "video/mp4" },
        { type: "video", data: "dmlkZW8=", mimeType: "video/mp4" },
        { type: "text", text: "after video" },
      ],
    },
    {
      name: "video without a text block",
      content: [{ type: "video", data: "dmlkZW8=", mimeType: "video/webm" }],
    },
  ])("preserves runtime $name content while merging prepared metadata", ({ content }) => {
    const recorder = createUserTurnTranscriptRecorder({
      input: {
        text: "canonical media caption",
        media: [{ path: "/tmp/video.mp4", contentType: "video/mp4" }],
        timestamp: 123,
      },
      target,
    });

    const merged = mergePreparedUserTurnMessageForRuntime({
      runtimeMessage: castAgentMessage({ role: "user", content }),
      preparedMessage: recorder.message,
    });

    expect(merged).toMatchObject({
      role: "user",
      content,
      timestamp: 123,
      __openclaw: {
        media: [{ path: "/tmp/video.mp4", contentType: "video/mp4" }],
      },
    });
    if (merged.role !== "user") {
      throw new Error("Expected a merged user-turn message");
    }
    expect(merged.content).toBe(content);
  });

  it("keeps canonical prepared text when runtime blocks contain no native media", () => {
    const recorder = createUserTurnTranscriptRecorder({
      input: { text: "canonical text", timestamp: 123 },
      target,
    });

    expect(
      mergePreparedUserTurnMessageForRuntime({
        runtimeMessage: castAgentMessage({
          role: "user",
          content: [{ type: "text", text: "runtime text" }],
        }),
        preparedMessage: recorder.message,
      }),
    ).toMatchObject({ content: "canonical text", timestamp: 123 });
  });
});
