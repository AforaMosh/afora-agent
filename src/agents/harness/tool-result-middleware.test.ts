import { NATIVE_TOOL_VIDEO_OMISSION } from "@openclaw/llm-core";
// Verifies tool-result middleware validation, sanitization, and fail-closed behavior.
import { describe, expect, it } from "vitest";
import { createAgentToolResultMiddlewareRunner } from "./tool-result-middleware.js";

describe("createAgentToolResultMiddlewareRunner", () => {
  it("fails closed when middleware throws", async () => {
    // Middleware errors may contain sensitive tool data. The public result must
    // collapse to a generic error instead of returning the thrown message.
    const runner = createAgentToolResultMiddlewareRunner({ runtime: "openclaw" }, [
      () => {
        throw new Error("raw secret should not be logged or returned");
      },
    ]);

    const result = await runner.applyToolResultMiddleware({
      toolCallId: "call-1",
      toolName: "exec",
      args: {},
      result: { content: [{ type: "text", text: "raw secret" }], details: {} },
    });

    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: "Tool output unavailable due to post-processing error.",
        },
      ],
      details: {
        status: "error",
        middlewareError: true,
      },
    });
  });

  it("fails closed for invalid middleware results", async () => {
    const original = { content: [{ type: "text" as const, text: "raw" }], details: {} };
    const runner = createAgentToolResultMiddlewareRunner({ runtime: "codex" }, [
      () => ({ result: { content: "not an array" } as never }),
    ]);

    const result = await runner.applyToolResultMiddleware({
      toolCallId: "call-1",
      toolName: "exec",
      args: {},
      result: original,
    });

    expect(result.details).toEqual({ status: "error", middlewareError: true });
  });

  it("fails closed when middleware mutates the current result into an invalid shape", async () => {
    const runner = createAgentToolResultMiddlewareRunner({ runtime: "openclaw" }, [
      (event) => {
        event.result.content = "not an array" as never;
        return undefined;
      },
    ]);

    const result = await runner.applyToolResultMiddleware({
      toolCallId: "call-1",
      toolName: "exec",
      args: {},
      result: { content: [{ type: "text", text: "raw" }], details: {} },
    });

    expect(result.details).toEqual({ status: "error", middlewareError: true });
  });

  it("rejects oversized multibyte middleware details", async () => {
    // Details are serialized into harness/tool payloads; cap them before a
    // middleware result can create unbounded transcript growth.
    const runner = createAgentToolResultMiddlewareRunner({ runtime: "codex" }, [
      () => ({
        result: {
          content: [{ type: "text", text: "compacted" }],
          details: { payload: "é".repeat(60_000) },
        },
      }),
    ]);

    const result = await runner.applyToolResultMiddleware({
      toolCallId: "call-1",
      toolName: "exec",
      args: {},
      result: { content: [{ type: "text", text: "raw" }], details: {} },
    });

    expect(result.details).toEqual({ status: "error", middlewareError: true });
  });

  it("rejects cyclic middleware details", async () => {
    const details: Record<string, unknown> = {};
    details.self = details;
    const runner = createAgentToolResultMiddlewareRunner({ runtime: "codex" }, [
      () => ({
        result: {
          content: [{ type: "text", text: "compacted" }],
          details,
        },
      }),
    ]);

    const result = await runner.applyToolResultMiddleware({
      toolCallId: "call-1",
      toolName: "exec",
      args: {},
      result: { content: [{ type: "text", text: "raw" }], details: {} },
    });

    expect(result.details).toEqual({ status: "error", middlewareError: true });
  });

  it("delivers a safe own-data snapshot when no middleware is registered", async () => {
    const client: Record<string, unknown> = { type: "fake-channel-client" };
    const cyclicDetails: Record<string, unknown> = {
      ok: true,
      messageId: "abc",
      delete: () => Promise.resolve(),
      client,
    };
    client.message = cyclicDetails;
    const original = {
      content: [{ type: "text" as const, text: "delivered" }],
      details: cyclicDetails,
    };
    const runner = createAgentToolResultMiddlewareRunner({ runtime: "openclaw" }, []);

    const result = await runner.applyToolResultMiddleware({
      toolCallId: "call-1",
      toolName: "message",
      args: {},
      result: original,
    });

    expect(result).not.toBe(original);
    expect(result).toEqual({
      content: [{ type: "text", text: "delivered" }],
      details: {
        ok: true,
        messageId: "abc",
        delete: {},
        client: { type: "fake-channel-client", message: "[Circular]" },
      },
    });
  });

  it("preserves empty content while malformed content still fails visibly without middleware", async () => {
    const runner = createAgentToolResultMiddlewareRunner({ runtime: "openclaw" }, []);
    const empty = { content: [], details: { ok: true } };

    const emptyResult = await runner.applyToolResultMiddleware({
      toolCallId: "call-empty",
      toolName: "inspect",
      args: {},
      result: empty,
    });
    const malformedResult = await runner.applyToolResultMiddleware({
      toolCallId: "call-malformed",
      toolName: "inspect",
      args: {},
      result: {
        content: [{ type: "unknown", payload: "raw" } as never],
        details: { ok: true },
      },
    });

    expect(emptyResult).toEqual(empty);
    expect(emptyResult).not.toBe(empty);
    expect(emptyResult.details).not.toBe(empty.details);
    expect(malformedResult).toEqual({
      content: [{ type: "text", text: "Tool output unavailable due to post-processing error." }],
      details: { status: "error", middlewareError: true },
    });
  });

  it("sanitizes incoming cyclic details so a no-op middleware does not fail closed", async () => {
    // The bug class behind silent Discord delivery in 2026.5.5: any plugin
    // that registers a tool-result middleware (e.g. bundled tokenjuice)
    // causes the harness to validate `event.result` against shape rules,
    // and tool emitters' raw channel-send payloads fail those rules.
    const client: Record<string, unknown> = { type: "fake-channel-client" };
    const payload: Record<string, unknown> = {
      ok: true,
      messageId: "1501757759073419394",
      delete: () => Promise.resolve(),
      client,
    };
    client.message = payload;
    const runner = createAgentToolResultMiddlewareRunner({ runtime: "openclaw" }, [
      () => undefined,
    ]);

    const result = await runner.applyToolResultMiddleware({
      toolCallId: "call-1",
      toolName: "message",
      args: {},
      result: {
        content: [{ type: "text", text: "delivered" }],
        details: payload,
      },
    });

    expect((result.details as { middlewareError?: boolean }).middlewareError).toBeUndefined();
    expect(result.details).toEqual({
      ok: true,
      messageId: "1501757759073419394",
      delete: {},
      client: { type: "fake-channel-client", message: "[Circular]" },
    });
  });

  it("truncates oversized incoming text before a no-op middleware", async () => {
    let observedText = "";
    const runner = createAgentToolResultMiddlewareRunner({ runtime: "openclaw" }, [
      (event) => {
        const content = event.result.content[0];
        observedText = content?.type === "text" ? content.text : "";
        return undefined;
      },
    ]);

    const result = await runner.applyToolResultMiddleware({
      toolCallId: "call-1",
      toolName: "gateway",
      args: { action: "config.get" },
      result: {
        content: [{ type: "text", text: "x".repeat(100_001) }],
        details: { ok: true },
      },
    });

    expect(observedText).toHaveLength(100_000);
    expect(result.details).toEqual({ ok: true });
    expect(result.content).toEqual([{ type: "text", text: "x".repeat(100_000) }]);
  });

  it("fails closed when middleware returns oversized top-level text", async () => {
    const runner = createAgentToolResultMiddlewareRunner({ runtime: "openclaw" }, [
      () => ({
        result: {
          content: [{ type: "text", text: "x".repeat(100_001) }],
          details: { ok: true },
        },
      }),
    ]);

    const result = await runner.applyToolResultMiddleware({
      toolCallId: "call-1",
      toolName: "gateway",
      args: { action: "config.get" },
      result: {
        content: [{ type: "text", text: "raw" }],
        details: { ok: true },
      },
    });

    expect(result.details).toEqual({ status: "error", middlewareError: true });
  });

  it("sanitizes incoming details before failing closed on uncoercible content", async () => {
    const details: Record<string, unknown> = {
      ok: true,
      callback: () => 1,
    };
    details.self = details;
    let observedDetails: unknown;
    const runner = createAgentToolResultMiddlewareRunner({ runtime: "codex" }, [
      (event) => {
        observedDetails = event.result.details;
        return undefined;
      },
    ]);

    const result = await runner.applyToolResultMiddleware({
      toolCallId: "call-1",
      toolName: "message",
      args: {},
      result: {
        content: [{ type: "unknown", payload: "raw" } as never],
        details,
      },
    });

    expect(result.details).toEqual({ status: "error", middlewareError: true });
    expect(observedDetails).toEqual({ ok: true, callback: {}, self: "[Circular]" });
  });

  it("coerces incoming nested toolResult content before middleware validation", async () => {
    const runner = createAgentToolResultMiddlewareRunner({ runtime: "codex" }, [() => undefined]);

    const result = await runner.applyToolResultMiddleware({
      toolCallId: "call-1",
      toolName: "message",
      args: {},
      result: {
        content: [
          {
            type: "toolResult",
            toolUseId: "call-1",
            content: [
              { type: "text", text: "sent message id msg_123" },
              { type: "text", text: "status delivered" },
            ],
          } as never,
        ],
        details: { status: "sent", messageId: "msg_123" },
      },
    });

    expect(result.content).toEqual([
      {
        type: "text",
        text: "sent message id msg_123\nstatus delivered",
      },
    ]);
    expect(result.details).toEqual({ status: "sent", messageId: "msg_123" });
  });

  it("coerces nested tool_result blocks returned by middleware", async () => {
    const runner = createAgentToolResultMiddlewareRunner({ runtime: "codex" }, [
      () => ({
        result: {
          content: [
            {
              type: "tool_result",
              content: {
                message: "message delivered",
                id: "msg_456",
              },
            } as never,
          ],
          details: { status: "sent" },
        },
      }),
    ]);

    const result = await runner.applyToolResultMiddleware({
      toolCallId: "call-1",
      toolName: "message",
      args: {},
      result: { content: [{ type: "text", text: "raw" }], details: {} },
    });

    expect(result.content).toEqual([{ type: "text", text: "message delivered" }]);
    expect(result.details).toEqual({ status: "sent" });
  });

  it("does not coerce tool/function call blocks as middleware results", async () => {
    const runner = createAgentToolResultMiddlewareRunner({ runtime: "codex" }, [
      () => ({
        result: {
          content: [
            {
              type: "function",
              name: "send_message",
              arguments: { text: "raw" },
            } as never,
          ],
          details: {},
        },
      }),
    ]);

    const result = await runner.applyToolResultMiddleware({
      toolCallId: "call-1",
      toolName: "message",
      args: {},
      result: { content: [{ type: "text", text: "raw" }], details: {} },
    });

    expect(result.details).toEqual({ status: "error", middlewareError: true });
  });

  it("bounds nested toolResult content before flattening", async () => {
    const runner = createAgentToolResultMiddlewareRunner({ runtime: "codex" }, [() => undefined]);

    const result = await runner.applyToolResultMiddleware({
      toolCallId: "call-1",
      toolName: "message",
      args: {},
      result: {
        content: [
          {
            type: "toolResult",
            toolUseId: "call-1",
            content: [
              ...Array.from({ length: 200 }, () => ({
                type: "text",
                text: "x".repeat(600),
              })),
              { type: "text", text: "late chunk" },
            ],
          } as never,
        ],
        details: {},
      },
    });

    const content = result.content[0];
    if (content?.type !== "text") {
      throw new Error("expected flattened text content");
    }
    expect(content.text.length).toBeLessThanOrEqual(100_000);
    expect(content.text).not.toContain("late chunk");
  });

  it("preserves nested image toolResult content without stringifying data", async () => {
    const runner = createAgentToolResultMiddlewareRunner({ runtime: "codex" }, [() => undefined]);

    const result = await runner.applyToolResultMiddleware({
      toolCallId: "call-1",
      toolName: "vision",
      args: {},
      result: {
        content: [
          {
            type: "toolResult",
            toolUseId: "call-1",
            content: [{ type: "image", mimeType: "image/png", data: "base64-image" }],
          } as never,
        ],
        details: {},
      },
    });

    expect(result.content).toEqual([
      { type: "image", mimeType: "image/png", data: "base64-image" },
    ]);
  });

  it("projects canonical video before registered middleware can retain raw bytes", async () => {
    const video = { type: "video" as const, mimeType: "video/mp4", data: "dmlkZW8=" };
    let observedContent: unknown;
    const runner = createAgentToolResultMiddlewareRunner({ runtime: "openclaw" }, [
      (event) => {
        observedContent = event.result.content;
        return undefined;
      },
      (event) => ({
        result: {
          ...event.result,
          content: [{ type: "text", text: "captured video" }, ...event.result.content],
        },
      }),
    ]);

    const result = await runner.applyToolResultMiddleware({
      toolCallId: "call-1",
      toolName: "camera",
      args: {},
      result: { content: [video], details: { status: "ok" } },
    });

    expect(observedContent).toEqual([{ type: "text", text: NATIVE_TOOL_VIDEO_OMISSION }]);
    expect(result.content).toEqual([
      { type: "text", text: "captured video" },
      { type: "text", text: NATIVE_TOOL_VIDEO_OMISSION },
    ]);
    expect(JSON.stringify(result)).not.toContain(video.data);
    expect(result.details).toEqual({ status: "ok" });
  });

  it("projects canonical video on the no-middleware path", async () => {
    const video = { type: "video" as const, mimeType: "video/webm", data: "dmlkZW8=" };
    const runner = createAgentToolResultMiddlewareRunner({ runtime: "openclaw" }, []);

    const result = await runner.applyToolResultMiddleware({
      toolCallId: "call-1",
      toolName: "camera",
      args: {},
      result: { content: [video], details: {} },
    });

    expect(result.content).toEqual([{ type: "text", text: NATIVE_TOOL_VIDEO_OMISSION }]);
    expect(JSON.stringify(result)).not.toContain(video.data);
  });

  it("preserves ordinary data-like text without middleware", async () => {
    const text = "metadata:key,value\nsome_data:text/plain,keep";
    const runner = createAgentToolResultMiddlewareRunner({ runtime: "openclaw" }, []);

    const result = await runner.applyToolResultMiddleware({
      toolCallId: "call-text",
      toolName: "inspect",
      args: {},
      result: { content: [{ type: "text", text }], details: {} },
    });

    expect(result.content).toEqual([{ type: "text", text }]);
  });

  it("redacts text data URLs and nested contentType media without middleware", async () => {
    const textPayload = "cHJpdmF0ZS10ZXh0";
    const nestedPayload = "cHJpdmF0ZS1uZXN0ZWQ=";
    const classPayload = "cHJpdmF0ZS1jbGFzcw==";
    const jsonPayload = "cHJpdmF0ZS10b0pTT04=";
    const plainJsonPayload = "cHJpdmF0ZS1wbGFpbi10b0pTT04=";
    let classSerializerCalls = 0;
    let plainSerializerCalls = 0;
    class NestedMediaEnvelope {
      nested = { content_type: "video/webm", blob: classPayload };
    }
    class JsonMediaEnvelope {
      #payload = jsonPayload;
      toJSON() {
        classSerializerCalls += 1;
        return { contentType: "video/mp4", data: this.#payload };
      }
    }
    const runner = createAgentToolResultMiddlewareRunner({ runtime: "openclaw" }, []);

    const result = await runner.applyToolResultMiddleware({
      toolCallId: "call-media",
      toolName: "inspect",
      args: {},
      result: {
        content: [{ type: "text", text: `preview data:image/png;base64,${textPayload}` }],
        details: {
          nested: { contentType: "video/mp4", data: nestedPayload },
          classEnvelope: new NestedMediaEnvelope(),
          jsonEnvelope: new JsonMediaEnvelope(),
          plainJsonEnvelope: {
            toJSON: () => {
              plainSerializerCalls += 1;
              return { contentType: "video/mp4", data: plainJsonPayload };
            },
          },
        },
      },
    });

    const serialized = JSON.stringify(result);
    expect(serialized).toContain("[media data omitted]");
    expect(serialized).not.toContain(textPayload);
    expect(serialized).not.toContain(nestedPayload);
    expect(serialized).not.toContain(classPayload);
    expect(serialized).not.toContain(jsonPayload);
    expect(serialized).not.toContain(plainJsonPayload);
    expect(classSerializerCalls).toBe(0);
    expect(plainSerializerCalls).toBe(0);
  });

  it("redacts prefixed wrapped data URLs before middleware and coerces nested media safely", async () => {
    const fragments = ["cHJpdmF0ZS", "13cmFwcGVk", "LXZpZGVv"];
    const nestedPayload = "cHJpdmF0ZS1ibG9i";
    let observed = "";
    const runner = createAgentToolResultMiddlewareRunner({ runtime: "openclaw" }, [
      (event) => {
        observed = JSON.stringify(event.result);
        return undefined;
      },
    ]);

    const result = await runner.applyToolResultMiddleware({
      toolCallId: "call-media",
      toolName: "inspect",
      args: {},
      result: {
        content: [
          {
            type: "toolResult",
            content: [
              {
                type: "text",
                text: `captured: data:video/mp4;base64,${fragments.join(" \t\n")}`,
              },
              {
                type: "json",
                payload: { content_type: "video/webm", blob: nestedPayload },
              },
            ],
          } as never,
        ],
        details: { contentType: "video/mp4", data: nestedPayload },
      },
    });

    const serialized = JSON.stringify(result);
    expect(observed).toContain("[media data omitted]");
    expect(serialized).toContain("[media data omitted]");
    for (const fragment of [...fragments, nestedPayload]) {
      expect(observed).not.toContain(fragment);
      expect(serialized).not.toContain(fragment);
    }
  });

  it("redacts data URLs introduced by middleware output", async () => {
    const payload = "cHJpdmF0ZS1taWRkbGV3YXJl";
    const runner = createAgentToolResultMiddlewareRunner({ runtime: "openclaw" }, [
      () => ({
        result: {
          content: [{ type: "text", text: `generated data:;base64,${payload}` }],
          details: {},
        },
      }),
    ]);

    const result = await runner.applyToolResultMiddleware({
      toolCallId: "call-media",
      toolName: "inspect",
      args: {},
      result: { content: [{ type: "text", text: "safe" }], details: {} },
    });

    expect(JSON.stringify(result)).toContain("[media data omitted]");
    expect(JSON.stringify(result)).not.toContain(payload);
  });

  it("materializes prototype-custom details while projecting nested media", async () => {
    class DetailEnvelope {
      status = "ok";
    }
    const ordinary = new DetailEnvelope() as DetailEnvelope & { self?: unknown };
    ordinary.self = ordinary;
    const runner = createAgentToolResultMiddlewareRunner({ runtime: "openclaw" }, []);

    const ordinaryResult = await runner.applyToolResultMiddleware({
      toolCallId: "call-ordinary",
      toolName: "inspect",
      args: {},
      result: { content: [{ type: "text", text: "ok" }], details: ordinary },
    });
    expect(ordinaryResult.details).not.toBe(ordinary);
    expect(Object.getPrototypeOf(ordinaryResult.details)).toBe(Object.prototype);
    expect(ordinaryResult.details).toEqual({ status: "ok", self: "[Circular]" });

    const privateData = "cHJpdmF0ZS12aWRlbw==";
    const mediaResult = await runner.applyToolResultMiddleware({
      toolCallId: "call-media",
      toolName: "inspect",
      args: {},
      result: {
        content: [{ type: "text", text: "ok" }],
        details: {
          nested: { type: "video", mimeType: "video/mp4", data: privateData },
          uri: `data:video/mp4;base64,${privateData}`,
        },
      },
    });
    expect(mediaResult.details).toBeDefined();
    expect((mediaResult.details as { nested?: unknown }).nested).toBe("[media data omitted]");
    expect(JSON.stringify(mediaResult.details)).not.toContain(privateData);
  });

  it("preserves images while projecting adjacent video", async () => {
    const image = { type: "image" as const, mimeType: "image/png", data: "base64-image" };
    const video = { type: "video" as const, mimeType: "video/mp4", data: "dmlkZW8=" };
    const runner = createAgentToolResultMiddlewareRunner({ runtime: "openclaw" }, [
      () => undefined,
    ]);

    const result = await runner.applyToolResultMiddleware({
      toolCallId: "call-1",
      toolName: "camera",
      args: {},
      result: { content: [image, video], details: {} },
    });

    expect(result.content).toEqual([image, { type: "text", text: NATIVE_TOOL_VIDEO_OMISSION }]);
  });

  it("fails closed when aggregate media exceeds the tool-result budget", async () => {
    const image = {
      type: "image" as const,
      mimeType: "image/png",
      data: "A".repeat(5_000_000),
    };
    const runner = createAgentToolResultMiddlewareRunner({ runtime: "openclaw" }, []);

    const result = await runner.applyToolResultMiddleware({
      toolCallId: "call-1",
      toolName: "camera",
      args: {},
      result: { content: Array.from({ length: 15 }, () => image), details: {} },
    });

    expect(result.details).toEqual({ status: "error", middlewareError: true });
    expect(JSON.stringify(result)).not.toContain(image.data);
  });

  it.each([
    { label: "non-video MIME", mimeType: "image/png", data: "dmlkZW8=" },
    { label: "unsafe MIME", mimeType: "video/mp4\ntext/plain", data: "dmlkZW8=" },
    { label: "oversized MIME", mimeType: `video/${"a".repeat(100)}`, data: "dmlkZW8=" },
    { label: "empty payload", mimeType: "video/mp4", data: "" },
    { label: "invalid base64", mimeType: "video/mp4", data: "not-base64!" },
    { label: "invalid padding", mimeType: "video/mp4", data: "dmlkZW8==" },
  ])("fails closed for video with $label", async ({ mimeType, data }) => {
    const runner = createAgentToolResultMiddlewareRunner({ runtime: "openclaw" }, []);

    const result = await runner.applyToolResultMiddleware({
      toolCallId: "call-1",
      toolName: "camera",
      args: {},
      result: { content: [{ type: "video", mimeType, data }], details: {} },
    });

    expect(result.details).toEqual({ status: "error", middlewareError: true });
  });

  it("projects nested video tool-result content without stringifying data", async () => {
    const video = { type: "video" as const, mimeType: "video/mp4", data: "dmlkZW8=" };
    const runner = createAgentToolResultMiddlewareRunner({ runtime: "openclaw" }, [
      () => undefined,
    ]);

    const result = await runner.applyToolResultMiddleware({
      toolCallId: "call-1",
      toolName: "camera",
      args: {},
      result: {
        content: [
          {
            type: "toolResult",
            content: [{ type: "text", text: "captured clip" }, video],
          } as never,
        ],
        details: {},
      },
    });

    expect(result.content).toEqual([
      { type: "text", text: "captured clip" },
      { type: "text", text: NATIVE_TOOL_VIDEO_OMISSION },
    ]);
    expect(JSON.stringify(result)).not.toContain(video.data);
  });

  it("fails closed instead of silently dropping malformed video beside valid text", async () => {
    const runner = createAgentToolResultMiddlewareRunner({ runtime: "openclaw" }, [
      () => undefined,
    ]);

    const result = await runner.applyToolResultMiddleware({
      toolCallId: "call-1",
      toolName: "camera",
      args: {},
      result: {
        content: [
          { type: "text", text: "captured clip" },
          { type: "video", mimeType: "video/mp4", data: "private-invalid-payload" },
        ],
        details: {},
      },
    });

    expect(result.details).toEqual({ status: "error", middlewareError: true });
    expect(JSON.stringify(result.content)).not.toContain("private-invalid-payload");
  });

  it("fails closed for malformed nested video without rendering its payload as text", async () => {
    const runner = createAgentToolResultMiddlewareRunner({ runtime: "openclaw" }, [
      () => undefined,
    ]);

    const result = await runner.applyToolResultMiddleware({
      toolCallId: "call-1",
      toolName: "camera",
      args: {},
      result: {
        content: [
          {
            type: "toolResult",
            content: [
              { type: "text", text: "captured clip" },
              { type: "video", mimeType: "video/mp4", data: "private-invalid-payload" },
            ],
          } as never,
        ],
        details: {},
      },
    });

    expect(result.details).toEqual({ status: "error", middlewareError: true });
    expect(JSON.stringify(result.content)).not.toContain("private-invalid-payload");
  });

  it("fails closed when valid top-level text precedes malformed nested video", async () => {
    const runner = createAgentToolResultMiddlewareRunner({ runtime: "openclaw" }, [
      () => undefined,
    ]);

    const result = await runner.applyToolResultMiddleware({
      toolCallId: "call-1",
      toolName: "camera",
      args: {},
      result: {
        content: [
          { type: "text", text: "captured clip" },
          {
            type: "toolResult",
            content: [{ type: "video", mimeType: "video/mp4", data: "private-invalid-payload" }],
          } as never,
        ],
        details: {},
      },
    });

    expect(result.details).toEqual({ status: "error", middlewareError: true });
    expect(JSON.stringify(result.content)).not.toContain("private-invalid-payload");
  });

  it("preserves mixed nested text and image toolResult content", async () => {
    const runner = createAgentToolResultMiddlewareRunner({ runtime: "codex" }, [() => undefined]);

    const result = await runner.applyToolResultMiddleware({
      toolCallId: "call-1",
      toolName: "screenshot",
      args: {},
      result: {
        content: [
          {
            type: "toolResult",
            toolUseId: "call-1",
            content: [
              { type: "text", text: "captured screenshot" },
              { type: "image", mimeType: "image/png", data: "base64-image" },
            ],
          } as never,
        ],
        details: {},
      },
    });

    expect(result.content).toEqual([
      { type: "text", text: "captured screenshot" },
      { type: "image", mimeType: "image/png", data: "base64-image" },
    ]);
  });

  it("preserves images from deeper nested toolResult content", async () => {
    const runner = createAgentToolResultMiddlewareRunner({ runtime: "codex" }, [() => undefined]);

    const result = await runner.applyToolResultMiddleware({
      toolCallId: "call-1",
      toolName: "screenshot",
      args: {},
      result: {
        content: [
          {
            type: "toolResult",
            toolUseId: "call-1",
            content: [
              {
                type: "tool_result",
                content: [
                  { type: "text", text: "captured screenshot" },
                  { type: "image", mimeType: "image/png", data: "base64-image" },
                ],
              },
            ],
          } as never,
        ],
        details: {},
      },
    });

    expect(result.content).toEqual([
      { type: "text", text: "captured screenshot" },
      { type: "image", mimeType: "image/png", data: "base64-image" },
    ]);
  });

  it("preserves interleaved nested text and image order", async () => {
    const runner = createAgentToolResultMiddlewareRunner({ runtime: "codex" }, [() => undefined]);

    const result = await runner.applyToolResultMiddleware({
      toolCallId: "call-1",
      toolName: "screenshot",
      args: {},
      result: {
        content: [
          {
            type: "toolResult",
            toolUseId: "call-1",
            content: [
              { type: "text", text: "first caption" },
              { type: "image", mimeType: "image/png", data: "image-one" },
              { type: "text", text: "second caption" },
              { type: "image", mimeType: "image/png", data: "image-two" },
            ],
          } as never,
        ],
        details: {},
      },
    });

    expect(result.content).toEqual([
      { type: "text", text: "first caption" },
      { type: "image", mimeType: "image/png", data: "image-one" },
      { type: "text", text: "second caption" },
      { type: "image", mimeType: "image/png", data: "image-two" },
    ]);
  });

  it("fails closed instead of recursing forever on cyclic nested content", async () => {
    const nested: Record<string, unknown> = {
      type: "toolResult",
      content: [],
    };
    nested.content = [nested];
    const runner = createAgentToolResultMiddlewareRunner({ runtime: "codex" }, [() => undefined]);

    const result = await runner.applyToolResultMiddleware({
      toolCallId: "call-1",
      toolName: "message",
      args: {},
      result: {
        content: [nested as never],
        details: {},
      },
    });

    expect(result.details).toEqual({ status: "error", middlewareError: true });
  });

  it("sanitizes incoming function/symbol/bigint values in details", async () => {
    const runner = createAgentToolResultMiddlewareRunner({ runtime: "codex" }, [() => undefined]);

    const result = await runner.applyToolResultMiddleware({
      toolCallId: "call-1",
      toolName: "exec",
      args: {},
      result: {
        content: [{ type: "text", text: "ok" }],
        details: {
          ok: true,
          exitCode: 0,
          callback: () => 1,
          tag: Symbol("x"),
          missing: undefined,
          id: 10n,
        },
      },
    });

    expect(result.details).toEqual({ ok: true, exitCode: 0, callback: {}, id: "10" });
  });

  it("collapses oversized incoming details to a truncation marker", async () => {
    const runner = createAgentToolResultMiddlewareRunner({ runtime: "openclaw" }, [
      () => undefined,
    ]);

    const result = await runner.applyToolResultMiddleware({
      toolCallId: "call-1",
      toolName: "exec",
      args: {},
      result: {
        content: [{ type: "text", text: "ok" }],
        details: { blob: "x".repeat(200_000) },
      },
    });

    const sanitized = result.details as { truncated?: boolean; originalSizeBytes?: number };
    expect(sanitized.truncated).toBe(true);
    expect(sanitized.originalSizeBytes ?? 0).toBeGreaterThan(100_000);
  });

  it("measures multibyte incoming details by serialized UTF-8 bytes", async () => {
    const runner = createAgentToolResultMiddlewareRunner({ runtime: "openclaw" }, [
      () => undefined,
    ]);
    const details = { blob: "é".repeat(60_000) };

    const result = await runner.applyToolResultMiddleware({
      toolCallId: "call-1",
      toolName: "exec",
      args: {},
      result: {
        content: [{ type: "text", text: "ok" }],
        details,
      },
    });

    expect(result.details).toEqual({
      truncated: true,
      originalSizeBytes: Buffer.byteLength(JSON.stringify(details)),
    });
  });

  it("snapshots confirmed delivery before oversized details are collapsed", async () => {
    const runner = createAgentToolResultMiddlewareRunner({ runtime: "codex" }, [
      () => {
        throw new Error("post-processing failed");
      },
    ]);

    const result = await runner.applyToolResultMiddleware({
      toolCallId: "call-1",
      toolName: "message",
      args: { action: "send", target: "C123" },
      result: {
        content: [{ type: "text", text: "raw result must stay private" }],
        details: {
          ok: true,
          result: { messageId: "1700000000.000100", channelId: "C123" },
          raw: "x".repeat(200_000),
        },
      },
    });

    expect(result).toEqual({
      content: [{ type: "text", text: "Message delivered, but result post-processing failed." }],
      details: {
        ok: true,
        deliveryStatus: "sent",
        middlewareWarning: "post-processing failed",
      },
    });
  });

  it("preserves confirmed delivery when middleware returns an explicit failure", async () => {
    const runner = createAgentToolResultMiddlewareRunner({ runtime: "codex" }, [
      () => ({
        result: {
          content: [{ type: "text", text: "post-processing failed" }],
          details: { status: "error", middlewareError: true },
        },
      }),
    ]);

    const result = await runner.applyToolResultMiddleware({
      toolCallId: "call-1",
      toolName: "message",
      args: { action: "send", target: "C123" },
      result: {
        content: [{ type: "text", text: "raw result must stay private" }],
        details: {
          ok: true,
          result: { messageId: "1700000000.000100", channelId: "C123" },
        },
      },
    });

    expect(result).toEqual({
      content: [{ type: "text", text: "Message delivered, but result post-processing failed." }],
      details: {
        ok: true,
        deliveryStatus: "sent",
        middlewareWarning: "post-processing failed",
      },
    });
  });

  it("accepts well-formed middleware results", async () => {
    const runner = createAgentToolResultMiddlewareRunner({ runtime: "codex" }, [
      (eventValue, ctx) => ({
        result: {
          content: [{ type: "text", text: "compacted" }],
          details: { compacted: true, runtime: ctx.runtime },
        },
      }),
    ]);

    const result = await runner.applyToolResultMiddleware({
      toolCallId: "call-1",
      toolName: "exec",
      args: {},
      result: { content: [{ type: "text", text: "raw" }], details: {} },
    });

    expect(result.content).toEqual([{ type: "text", text: "compacted" }]);
    expect(result.details).toEqual({ compacted: true, runtime: "codex" });
  });
});
