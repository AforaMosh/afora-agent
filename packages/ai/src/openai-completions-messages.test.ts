import { describe, expect, it } from "vitest";
import { convertMessages } from "./openai-completions-messages.js";
import {
  captureOpenAICompatibleChatVideoProvenance,
  enforceOpenAICompatibleChatVideoRequestLimits,
} from "./providers/openai-compatible-video-content.js";
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

  it("favors the current user video when history fills the item limit", () => {
    const converted = convertMessages(
      videoModel,
      {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "history" },
              { type: "video", mimeType: "video/mp4", data: "b2xk" },
            ],
            timestamp: 1,
          },
          {
            role: "user",
            content: [
              { type: "text", text: "current" },
              { type: "video", mimeType: "video/quicktime", data: "bmV3" },
            ],
            timestamp: 2,
          },
        ],
      },
      resolveOpenAICompletionsCompat(videoModel),
    );

    expect(converted).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "history" },
          { type: "text", text: "(video omitted: unsupported or exceeds provider limits)" },
        ],
      },
      {
        role: "user",
        content: [
          { type: "text", text: "current" },
          { type: "video_url", video_url: { url: "data:video/mov;base64,bmV3" } },
        ],
      },
    ]);
  });

  it("favors the current user video when history would exhaust aggregate bytes", () => {
    const aggregateModel = {
      ...videoModel,
      nativeVideoInput: { ...nativeVideoInput, maxItems: 2 },
    } satisfies Model<"openai-completions">;
    const converted = convertMessages(
      aggregateModel,
      {
        messages: [
          {
            role: "user",
            content: [{ type: "video", mimeType: "video/mp4", data: "b2xk" }],
            timestamp: 1,
          },
          {
            role: "user",
            content: [{ type: "video", mimeType: "video/mp4", data: "bmV3" }],
            timestamp: 2,
          },
        ],
      },
      resolveOpenAICompletionsCompat(aggregateModel),
    );

    expect(converted).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "(video omitted: unsupported or exceeds provider limits)" },
        ],
      },
      {
        role: "user",
        content: [{ type: "video_url", video_url: { url: "data:video/mp4;base64,bmV3" } }],
      },
    ]);
  });

  it("preserves video order within the current user message", () => {
    const multiVideoModel = {
      ...videoModel,
      nativeVideoInput: {
        ...nativeVideoInput,
        maxItems: 2,
        maxAggregateDecodedBytes: 10,
      },
    } satisfies Model<"openai-completions">;
    const converted = convertMessages(
      multiVideoModel,
      {
        messages: [
          {
            role: "user",
            content: [
              { type: "video", mimeType: "video/quicktime", data: "b25lIQ==" },
              { type: "text", text: "between" },
              { type: "video", mimeType: "video/mp4", data: "dHdvIQ==" },
            ],
            timestamp: 1,
          },
        ],
      },
      resolveOpenAICompletionsCompat(multiVideoModel),
    );

    expect(converted).toEqual([
      {
        role: "user",
        content: [
          { type: "video_url", video_url: { url: "data:video/mov;base64,b25lIQ==" } },
          { type: "text", text: "between" },
          { type: "video_url", video_url: { url: "data:video/mp4;base64,dHdvIQ==" } },
        ],
      },
    ]);
  });

  it("keeps chronological wire order after newest-first admission planning", () => {
    const orderedModel = {
      ...videoModel,
      nativeVideoInput: {
        ...nativeVideoInput,
        maxItems: 2,
        maxAggregateDecodedBytes: 10,
      },
    } satisfies Model<"openai-completions">;
    const converted = convertMessages(
      orderedModel,
      {
        messages: [
          {
            role: "user",
            content: [{ type: "video", mimeType: "video/mp4", data: "b2xk" }],
            timestamp: 1,
          },
          { role: "user", content: "middle", timestamp: 2 },
          {
            role: "user",
            content: [{ type: "video", mimeType: "video/mp4", data: "bmV3" }],
            timestamp: 3,
          },
        ],
      },
      resolveOpenAICompletionsCompat(orderedModel),
    );

    expect(converted).toEqual([
      {
        role: "user",
        content: [{ type: "video_url", video_url: { url: "data:video/mp4;base64,b2xk" } }],
      },
      { role: "user", content: "middle" },
      {
        role: "user",
        content: [{ type: "video_url", video_url: { url: "data:video/mp4;base64,bmV3" } }],
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
    const provenance = captureOpenAICompatibleChatVideoProvenance(params);
    enforceOpenAICompatibleChatVideoRequestLimits(
      params,
      {
        nativeVideoInput: { ...nativeVideoInput, maxSerializedRequestBytesExclusive: 1 },
      },
      provenance,
    );
    expect(JSON.stringify(params)).not.toContain("dmlkZW8=");
    expect(params.messages[0]?.content).toEqual([
      { type: "text", text: "(video omitted: unsupported or exceeds provider limits)" },
    ]);
  });

  it("uses pre-hook oldest-first order at the serialized request cap", () => {
    const historicalData = Buffer.alloc(128, 1).toString("base64");
    const currentData = Buffer.alloc(128, 2).toString("base64");
    const expectedMessages = [
      {
        role: "user",
        content: [
          {
            type: "video_url",
            video_url: { url: `data:video/mov;base64,${currentData}` },
          },
        ],
      },
      {
        role: "user",
        content: [
          { type: "text", text: "(video omitted: unsupported or exceeds provider limits)" },
        ],
      },
    ];
    const maxSerializedRequestBytesExclusive =
      Buffer.byteLength(JSON.stringify({ model: "kimi-k3", messages: expectedMessages })) + 1;
    const params = {
      model: "kimi-k3",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "video_url",
              video_url: { url: `data:video/mp4;base64,${historicalData}` },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "video_url",
              video_url: { url: `data:video/quicktime;base64,${currentData}` },
            },
          ],
        },
      ],
    };

    const provenance = captureOpenAICompatibleChatVideoProvenance(params);
    params.messages.reverse();
    enforceOpenAICompatibleChatVideoRequestLimits(
      params,
      {
        nativeVideoInput: {
          ...nativeVideoInput,
          maxDecodedBytesPerItem: 128,
          maxItems: 2,
          maxAggregateDecodedBytes: 256,
          maxSerializedRequestBytesExclusive,
        },
      },
      provenance,
    );

    expect(params.messages).toEqual(expectedMessages);
    expect(Buffer.byteLength(JSON.stringify(params))).toBeLessThan(
      maxSerializedRequestBytesExclusive,
    );
  });

  it.each([
    ["structured clone", (value: unknown) => structuredClone(value)],
    ["JSON roundtrip", (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown],
  ])("preserves original video across a %s payload replacement", (_name, clone) => {
    const original = {
      messages: [
        {
          role: "user",
          content: [{ type: "video_url", video_url: { url: "data:video/mp4;base64,bmV3" } }],
        },
      ],
    };
    const provenance = captureOpenAICompatibleChatVideoProvenance(original);
    const replacement = clone(original) as typeof original;

    enforceOpenAICompatibleChatVideoRequestLimits(replacement, videoModel, provenance);

    expect(replacement.messages[0]?.content).toEqual([
      { type: "video_url", video_url: { url: "data:video/mp4;base64,bmV3" } },
    ]);
  });

  it("admits only the captured occurrences after a hook injects an identical video", () => {
    const videoPart = {
      type: "video_url",
      video_url: { url: "data:video/mp4;base64,bmV3" },
    };
    const original = {
      messages: [
        { role: "user", content: [structuredClone(videoPart), structuredClone(videoPart)] },
      ],
    };
    const provenance = captureOpenAICompatibleChatVideoProvenance(original);
    const replacement = JSON.parse(JSON.stringify(original)) as typeof original;
    replacement.messages[0]!.content.push(structuredClone(videoPart));

    enforceOpenAICompatibleChatVideoRequestLimits(
      replacement,
      {
        nativeVideoInput: {
          ...nativeVideoInput,
          maxItems: 3,
          maxAggregateDecodedBytes: 15,
        },
      },
      provenance,
    );

    expect(replacement.messages[0]?.content).toEqual([
      videoPart,
      videoPart,
      { type: "text", text: "(video omitted: unsupported or exceeds provider limits)" },
    ]);
  });

  it("rebuilds a provenance-matched part without hook-added video carriers", () => {
    const original = {
      messages: [
        {
          role: "user",
          content: [{ type: "video_url", video_url: { url: "data:video/mp4;base64,bmV3" } }],
        },
      ],
    };
    const provenance = captureOpenAICompatibleChatVideoProvenance(original);
    const augmented = original.messages[0]!.content[0]! as Record<string, unknown>;
    augmented.blob = "private-hook-blob";
    augmented.image_url = {
      url: "data:video/mp4;base64,private-hook-image-url",
    };

    enforceOpenAICompatibleChatVideoRequestLimits(original, videoModel, provenance);

    expect(original.messages[0]?.content).toEqual([
      { type: "video_url", video_url: { url: "data:video/mp4;base64,bmV3" } },
    ]);
    expect(JSON.stringify(original)).not.toContain("private-hook");
  });

  const providerWrappedVideos: Array<{
    name: string;
    block: (dataUrl: string, data: string) => Record<string, unknown>;
  }> = [
    {
      name: "input_video URL",
      block: (dataUrl: string) => ({ type: "input_video", video_url: dataUrl }),
    },
    {
      name: "video source inheriting its enclosing type",
      block: (_dataUrl: string, data: string) => ({
        type: "video",
        source: { type: "base64", data },
      }),
    },
    {
      name: "image_url carrying video data",
      block: (dataUrl: string) => ({ type: "image_url", image_url: { url: dataUrl } }),
    },
    {
      name: "nested URL object",
      block: (dataUrl: string) => ({
        type: "video_url",
        video_url: { url: { url: dataUrl } },
      }),
    },
    ...["mimeType", "mime_type", "mediaType", "media_type", "contentType", "content_type"].map(
      (mimeField, index) => ({
        name: `${mimeField} ${index % 2 === 0 ? "data" : "blob"}`,
        block: (_dataUrl: string, data: string) => ({
          type: "image",
          [mimeField]: " VIDEO/MP4 ",
          [index % 2 === 0 ? "data" : "blob"]: data,
        }),
      }),
    ),
  ];

  it.each(providerWrappedVideos)("omits a hook-relabeled $name payload", ({ block }) => {
    const data = "private-relabeled-video";
    const original = {
      messages: [
        {
          role: "user",
          content: [{ type: "video_url", video_url: { url: `data:video/mp4;base64,${data}` } }],
        },
      ],
    };
    const provenance = captureOpenAICompatibleChatVideoProvenance(original);
    const request: { messages: Array<{ role: string; content: unknown[] }> } = original;
    request.messages[0]!.content[0] = block(`data:video/mp4;base64,${data}`, data);

    enforceOpenAICompatibleChatVideoRequestLimits(request, videoModel, provenance);

    expect(request.messages[0]?.content).toEqual([
      { type: "text", text: "(video omitted: unsupported or exceeds provider limits)" },
    ]);
    expect(JSON.stringify(request)).not.toContain(data);
  });

  it.each(providerWrappedVideos)("omits a hook-injected $name payload", ({ block }) => {
    const injectedData = "private-injected-video";
    const original = {
      messages: [
        {
          role: "user",
          content: [{ type: "video_url", video_url: { url: "data:video/mp4;base64,bmV3" } }],
        },
      ],
    };
    const provenance = captureOpenAICompatibleChatVideoProvenance(original);
    const request: { messages: Array<{ role: string; content: unknown[] }> } = original;
    request.messages[0]!.content.push(block(`data:video/mp4;base64,${injectedData}`, injectedData));

    enforceOpenAICompatibleChatVideoRequestLimits(request, videoModel, provenance);

    expect(request.messages[0]?.content).toEqual([
      { type: "video_url", video_url: { url: "data:video/mp4;base64,bmV3" } },
      { type: "text", text: "(video omitted: unsupported or exceeds provider limits)" },
    ]);
    expect(JSON.stringify(request)).not.toContain(injectedData);
  });

  it("leaves remote provider video wrappers unchanged", () => {
    const request = {
      messages: [
        {
          role: "assistant",
          content: [
            { type: "input_video", video_url: "https://example.test/video.mp4" },
            { type: "video_url", video_url: { url: "https://example.test/other.mp4" } },
          ],
        },
      ],
    };
    const original = structuredClone(request);

    enforceOpenAICompatibleChatVideoRequestLimits(
      request,
      videoModel,
      captureOpenAICompatibleChatVideoProvenance(request),
    );

    expect(request).toEqual(original);
  });

  it.each([
    [
      "reordered",
      (request: { messages: Array<{ content: unknown[] }> }) =>
        request.messages[0]!.content.reverse(),
    ],
    [
      "moved",
      (request: { messages: Array<{ content: unknown[] }> }) =>
        request.messages.push({ content: [request.messages[0]!.content.shift()] }),
    ],
    [
      "modified",
      (request: { messages: Array<{ content: Array<{ video_url?: { url: string } }> }> }) => {
        request.messages[0]!.content[0]!.video_url!.url = "data:video/mp4;base64,bW9kaWZpZWQ=";
      },
    ],
  ])("fails closed when cloned hook video is %s", (_name, mutate) => {
    const original = {
      messages: [
        {
          role: "user",
          content: [
            { type: "video_url", video_url: { url: "data:video/mp4;base64,b25l" } },
            { type: "video_url", video_url: { url: "data:video/mp4;base64,dHdv" } },
          ],
        },
      ],
    };
    const provenance = captureOpenAICompatibleChatVideoProvenance(original);
    const replacement = structuredClone(original) as typeof original;
    mutate(replacement as never);

    enforceOpenAICompatibleChatVideoRequestLimits(
      replacement,
      {
        nativeVideoInput: {
          ...nativeVideoInput,
          maxItems: 2,
          maxAggregateDecodedBytes: 10,
        },
      },
      provenance,
    );

    const serialized = JSON.stringify(replacement);
    expect(serialized).not.toMatch(/base64,(?:b25l|bW9kaWZpZWQ=)/u);
    if (_name !== "modified") {
      expect(serialized).not.toContain("base64,dHdv");
    }
  });

  it("retains pre-hook current-turn priority when intact user turns are reordered", () => {
    const original = {
      messages: [
        {
          role: "user",
          content: [{ type: "video_url", video_url: { url: "data:video/mp4;base64,b2xk" } }],
        },
        {
          role: "user",
          content: [{ type: "video_url", video_url: { url: "data:video/mp4;base64,bmV3" } }],
        },
      ],
    };
    const provenance = captureOpenAICompatibleChatVideoProvenance(original);
    original.messages.reverse();

    enforceOpenAICompatibleChatVideoRequestLimits(original, videoModel, provenance);

    expect(original.messages).toEqual([
      {
        role: "user",
        content: [{ type: "video_url", video_url: { url: "data:video/mp4;base64,bmV3" } }],
      },
      {
        role: "user",
        content: [
          { type: "text", text: "(video omitted: unsupported or exceeds provider limits)" },
        ],
      },
    ]);
  });
});
