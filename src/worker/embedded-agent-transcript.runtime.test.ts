import { describe, expect, it, vi } from "vitest";
import type { WorkerLiveEvent } from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import type { AgentMessage } from "../agents/runtime/index.js";
import type { Context, UserMessage } from "../llm/types.js";
import { createWorkerLiveRuntime } from "./embedded-agent-live.runtime.js";
import {
  createWorkerTranscriptRuntime,
  toAgentMessage,
  toWorkerInferenceContext,
} from "./embedded-agent-transcript.runtime.js";
import {
  isWorkerTranscriptMessageFrameSafe,
  toWorkerTranscriptMessage,
} from "./transcript-message.js";

const tinyVideo = { type: "video" as const, data: "Y2xpcA==", mimeType: "video/mp4" };

function projectMessage(message: AgentMessage) {
  const projected = toWorkerTranscriptMessage(message, "transcript");
  if (!projected || projected.kind !== "complete") {
    throw new Error("expected complete worker message projection");
  }
  return projected.message;
}

function projectContext(context: Context) {
  const projected = toWorkerInferenceContext(context);
  if (projected.kind !== "complete") {
    throw new Error("expected complete worker inference context projection");
  }
  return projected.context;
}

describe("worker video downgrade boundaries", () => {
  it("projects video to bounded text across both worker transcript adapters", () => {
    const message: UserMessage = {
      role: "user",
      content: [{ type: "text", text: "What happens?" }, tinyVideo],
      timestamp: 1,
    };

    const projected = projectMessage(message);

    const expected = {
      role: "user" as const,
      content: [
        { type: "text" as const, text: "What happens?" },
        {
          type: "text" as const,
          text: "(video omitted: attachment is unavailable to the cloud worker)",
        },
      ],
      timestamp: 1,
    };
    expect(projected).toEqual(expected);
    expect(projected && toAgentMessage(projected)).toEqual(expected);
    expect(projected && isWorkerTranscriptMessageFrameSafe(projected)).toBe(true);
  });

  it("never makes transcript omission depend on video byte size", () => {
    const message: UserMessage = {
      role: "user",
      content: [
        { type: "text", text: "What happens?" },
        { ...tinyVideo, data: "private-large-video".repeat(1_000) },
      ],
      timestamp: 1,
    };

    const projected = projectMessage(message);

    expect(projected).toEqual({
      role: "user",
      content: [
        { type: "text", text: "What happens?" },
        {
          type: "text",
          text: "(video omitted: attachment is unavailable to the cloud worker)",
        },
      ],
      timestamp: 1,
    });
    expect(projected && isWorkerTranscriptMessageFrameSafe(projected)).toBe(true);
  });

  it("preserves interleaved captions and media while replacing video in place", () => {
    const imageA = { type: "image" as const, data: "aW1hZ2UtYQ==", mimeType: "image/png" };
    const imageB = { type: "image" as const, data: "aW1hZ2UtYg==", mimeType: "image/jpeg" };
    const video = { ...tinyVideo, data: "cHJpdmF0ZS12aWRlbw==" };
    const message = {
      role: "user" as const,
      content: [
        { type: "text" as const, text: "caption A" },
        imageA,
        { type: "text" as const, text: "caption B" },
        video,
        { type: "text" as const, text: "caption C" },
        imageB,
      ],
      timestamp: 1,
      __openclaw: {
        media: [
          { kind: "image" as const, sourceIndex: 0 },
          { kind: "video" as const, sourceIndex: 1 },
          { kind: "image" as const, sourceIndex: 2 },
        ],
        mediaBlockFactIndexes: [0, 1, 2],
      },
    };

    const projected = projectMessage(message);

    expect(projected.content).toEqual([
      { type: "text", text: "caption A" },
      imageA,
      { type: "text", text: "caption B" },
      { type: "text", text: "(video omitted: attachment is unavailable to the cloud worker)" },
      { type: "text", text: "caption C" },
      imageB,
    ]);
    expect(projectContext({ messages: [message] }).messages[0]).toEqual(projected);
    expect(JSON.stringify(projected)).not.toContain(video.data);
  });

  it("makes durable-reference-only video visible without trusting worker media metadata", () => {
    const message = {
      role: "user" as const,
      content: "What happens?",
      timestamp: 1,
      __openclaw: {
        media: [{ kind: "video" as const, url: "media://inbound/clip.mp4" }],
      },
    };

    expect(projectMessage(message)).toEqual({
      role: "user",
      content: [
        { type: "text", text: "What happens?" },
        {
          type: "text",
          text: "(video omitted: attachment is unavailable to the cloud worker)",
        },
      ],
      timestamp: 1,
    });
  });

  it("appends reference-only video omissions without disturbing inline content", () => {
    const image = { type: "image" as const, data: "aW1hZ2U=", mimeType: "image/png" };
    const message = {
      role: "user" as const,
      content: [{ type: "text" as const, text: "compare" }, image],
      timestamp: 1,
      __openclaw: {
        media: [
          {
            kind: "video" as const,
            sourceId: "video-0",
            sourceIndex: 0,
            url: "media://inbound/clip.mp4",
          },
          { kind: "image" as const, sourceId: "image-1", sourceIndex: 1 },
        ],
        mediaBlockFactIndexes: [1],
      },
    };

    expect(projectMessage(message)).toEqual({
      role: "user",
      content: [
        { type: "text", text: "compare" },
        image,
        { type: "text", text: "(video omitted: attachment is unavailable to the cloud worker)" },
      ],
      timestamp: 1,
    });
    expect(projectContext({ messages: [message] }).messages[0]).toEqual(projectMessage(message));
  });

  it("emits one omission for every reference-only clip", () => {
    const message = {
      role: "user" as const,
      content: "compare",
      timestamp: 1,
      __openclaw: {
        media: [
          { kind: "video" as const, sourceIndex: 0, url: "media://inbound/first.mp4" },
          { kind: "video" as const, sourceIndex: 1, url: "media://inbound/second.mp4" },
        ],
      },
    };

    const projected = projectMessage(message);
    expect(projected?.content.filter((part) => part.type === "text")).toHaveLength(3);
    expect(JSON.stringify(projected).match(/attachment is unavailable/g)).toHaveLength(2);
  });

  it("projects historical video before building worker inference context", () => {
    expect(
      projectContext({
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "What happens?" }, tinyVideo],
            timestamp: 1,
          },
        ],
      }),
    ).toEqual({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "What happens?" },
            {
              type: "text",
              text: "(video omitted: attachment is unavailable to the cloud worker)",
            },
          ],
          timestamp: 1,
        },
      ],
    });
  });

  it("commits a local-tool clip as a bounded visible omission", async () => {
    const commit = vi.fn(async () => undefined);
    const runtime = createWorkerTranscriptRuntime({ commit });

    runtime.onMessagePersisted({
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "read",
      content: [{ type: "text", text: "Clip captured." }, tinyVideo],
      isError: false,
      timestamp: 1,
    });
    await runtime.withSessionWriteLock(() => undefined);

    expect(commit).toHaveBeenCalledWith([
      expect.objectContaining({
        role: "toolResult",
        content: [
          { type: "text", text: "Clip captured." },
          {
            type: "text",
            text: "(video omitted: attachment is unavailable to the cloud worker)",
          },
        ],
      }),
    ]);
  });

  it("redacts native video bytes from every worker tool live-event phase", async () => {
    const emit = vi.fn(async (_event: WorkerLiveEvent) => undefined);
    const runtime = createWorkerLiveRuntime({ emit });
    const media = { ...tinyVideo, data: "c2Vuc2l0aXZlLXZpZGVvLWJ5dGVz" };
    const identity = { toolCallId: "call-1", toolName: "read" };

    runtime.handleSessionEvent({ type: "tool_execution_start", ...identity, args: { media } });
    runtime.handleSessionEvent({
      type: "tool_execution_update",
      ...identity,
      args: {},
      partialResult: { media },
    });
    runtime.handleSessionEvent({
      type: "tool_execution_end",
      ...identity,
      isError: false,
      result: { media },
    });
    await runtime.flush();

    expect(emit).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(emit.mock.calls)).not.toContain(media.data);
    for (const [event] of emit.mock.calls) {
      if (event.kind !== "tool") {
        throw new Error("expected a worker tool live event");
      }
      const value =
        event.payload.phase === "start"
          ? event.payload.args
          : event.payload.phase === "update"
            ? event.payload.partialResult
            : event.payload.result;
      expect(value).toEqual({
        media: expect.objectContaining({ type: "video", data: "<redacted>" }),
      });
    }
  });
});
