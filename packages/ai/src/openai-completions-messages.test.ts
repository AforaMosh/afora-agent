import { describe, expect, it } from "vitest";
import { convertMessages } from "./openai-completions-messages.js";
import { enforceOpenAICompatibleChatVideoRequestLimits } from "./providers/openai-compatible-video-content.js";
import { resolveOpenAICompletionsCompat } from "./transports/openai-completions-compat.js";
import type { AssistantMessage, Context, Model } from "./types.js";

const model: Model<"openai-completions"> = {
  id: "test-model",
  name: "Test model",
  api: "openai-completions",
  provider: "custom-openai-compatible",
  baseUrl: "https://proxy.example/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4_096,
};

const emptyUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe("convertMessages assistant text replay", () => {
  it("keeps separate assistant text blocks apart", () => {
    const assistant: AssistantMessage = {
      role: "assistant",
      api: model.api,
      provider: model.provider,
      model: model.id,
      content: [
        { type: "text", text: "Let me check the file." },
        { type: "text", text: "The file contains X." },
      ],
      usage: emptyUsage,
      stopReason: "stop",
      timestamp: 2,
    };
    const context: Context = {
      messages: [{ role: "user", content: "hello", timestamp: 1 }, assistant],
    };

    const converted = convertMessages(model, context, resolveOpenAICompletionsCompat(model));

    const replayed = converted.find((message) => message.role === "assistant");
    expect(replayed?.content).toBe("Let me check the file.\nThe file contains X.");
  });

  it("keeps paired OpenAI tool call ids UTF-16 safe when truncating", () => {
    const prefix = "a".repeat(39);
    const oversizedId = `${prefix}🐱`;
    const targetModel: Model<"openai-completions"> = {
      ...model,
      id: "target-model",
      provider: "openai",
    };
    const assistant: AssistantMessage = {
      role: "assistant",
      api: targetModel.api,
      provider: targetModel.provider,
      model: "source-model",
      content: [{ type: "toolCall", id: oversizedId, name: "lookup", arguments: {} }],
      usage: emptyUsage,
      stopReason: "toolUse",
      timestamp: 1,
    };
    const context: Context = {
      messages: [
        assistant,
        {
          role: "toolResult",
          toolCallId: oversizedId,
          toolName: "lookup",
          content: [{ type: "text", text: "ok" }],
          isError: false,
          timestamp: 2,
        },
      ],
    };

    const converted = convertMessages(
      targetModel,
      context,
      resolveOpenAICompletionsCompat(targetModel),
    );
    const assistantParam = converted.find((message) => message.role === "assistant");
    const toolParam = converted.find((message) => message.role === "tool");
    const normalizedAssistantId =
      assistantParam?.role === "assistant" ? assistantParam.tool_calls?.[0]?.id : undefined;
    const normalizedToolResultId = toolParam?.role === "tool" ? toolParam.tool_call_id : undefined;

    expect(oversizedId.slice(0, 40).charCodeAt(39)).toBe(0xd83d);
    expect(normalizedAssistantId).toBe(prefix);
    expect(normalizedToolResultId).toBe(prefix);
  });
});

describe("convertMessages provider-owned native video", () => {
  const nativeVideoInput = {
    wireFamily: "openai-chat-video-url",
    mimeTypes: {
      "video/mp4": "video/mp4",
      "video/quicktime": "video/mov",
    },
    maxDecodedBytesPerItem: 5,
    maxItems: 1,
    maxAggregateDecodedBytes: 5,
    aggregateScope: "video",
    maxSerializedRequestBytesExclusive: 10_000,
  } as const;
  const videoModel = {
    ...model,
    input: ["text", "image", "video"],
    nativeVideoInput,
  } satisfies Model<"openai-completions">;

  it("uses only the prepared contract and enforces MIME aliases, count, and aggregate bytes", () => {
    const converted = convertMessages(
      videoModel,
      {
        messages: [
          {
            role: "user",
            content: [
              { type: "video", mimeType: "video/quicktime", data: "dmlkZW8=" },
              { type: "video", mimeType: "video/mp4", data: "dmlkZW8=" },
              { type: "video", mimeType: "video/x-m4v", data: "dmlkZW8=" },
            ],
            timestamp: 1,
          },
        ],
      },
      resolveOpenAICompletionsCompat(videoModel),
    );

    expect(converted).toEqual([
      {
        role: "user",
        content: [
          { type: "video_url", video_url: { url: "data:video/mov;base64,dmlkZW8=" } },
          { type: "text", text: "(video omitted: unsupported or exceeds provider limits)" },
          { type: "text", text: "(video omitted: unsupported or exceeds provider limits)" },
        ],
      },
    ]);
  });

  it("never treats raw model.input or tool-result video as native support", () => {
    const unsupportedModel = {
      ...model,
      input: ["text", "video"],
    } satisfies Model<"openai-completions">;
    const converted = convertMessages(
      unsupportedModel,
      {
        messages: [
          {
            role: "user",
            content: [{ type: "video", mimeType: "video/mp4", data: "private-user" }],
            timestamp: 1,
          },
          {
            role: "toolResult",
            toolCallId: "call_video",
            toolName: "video",
            content: [{ type: "video", mimeType: "video/mp4", data: "private-tool" }],
            isError: false,
            timestamp: 2,
          },
        ],
      },
      resolveOpenAICompletionsCompat(unsupportedModel),
    );
    const serialized = JSON.stringify(converted);
    expect(serialized).toContain("video omitted");
    expect(serialized).toContain("native tool-result video is unsupported");
    expect(serialized).not.toContain("private-user");
    expect(serialized).not.toContain("private-tool");
    expect(serialized).not.toContain("video_url");
  });

  it("removes accepted video when the final serialized request reaches the exclusive cap", () => {
    const params = {
      model: "kimi-k3",
      messages: [
        {
          role: "user",
          content: [{ type: "video_url", video_url: { url: "data:video/mp4;base64,dmlkZW8=" } }],
        },
      ],
    };
    enforceOpenAICompatibleChatVideoRequestLimits(params, {
      nativeVideoInput: { ...nativeVideoInput, maxSerializedRequestBytesExclusive: 1 },
    });
    expect(JSON.stringify(params)).not.toContain("dmlkZW8=");
    expect(params.messages[0]?.content).toEqual([
      { type: "text", text: "(video omitted: unsupported or exceeds provider limits)" },
    ]);
  });
});
