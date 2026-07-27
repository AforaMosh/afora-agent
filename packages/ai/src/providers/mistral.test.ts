// Mistral provider tests cover request mapping and stream conversion.
import { toolCallFromJSON } from "@mistralai/mistralai/models/components";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureAiTransportHost } from "../host.js";
import type { Context, Model } from "../types.js";
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "../utils/system-prompt-cache-boundary.js";

const mistralMockState = vi.hoisted(() => ({
  configs: [] as unknown[],
  payloads: [] as unknown[],
  requestOptions: [] as unknown[],
  randomUUIDs: [] as string[],
  streamError: new Error("stop before network") as unknown,
  streamResult: undefined as unknown,
}));

vi.mock("node:crypto", async () => {
  const actual = await vi.importActual<typeof import("node:crypto")>("node:crypto");
  return {
    ...actual,
    randomUUID: () => mistralMockState.randomUUIDs.shift() ?? actual.randomUUID(),
  };
});

vi.mock("@mistralai/mistralai", async () => {
  // Preserve real exports for everything except `Mistral`, so the new
  // imports of `HTTPClient` and `Fetcher` introduced by the bounded-stream
  // helper (`createBoundedMistralHttpClient`) resolve correctly. Only
  // `Mistral` itself is overridden so the test can capture payloads without
  // any actual HTTP traffic.
  const actual =
    await vi.importActual<typeof import("@mistralai/mistralai")>("@mistralai/mistralai");
  return {
    ...actual,
    Mistral: class MockMistral {
      constructor(config: unknown) {
        mistralMockState.configs.push(config);
      }

      chat = {
        stream: vi.fn(async (payload: unknown, requestOptions: unknown) => {
          mistralMockState.payloads.push(payload);
          mistralMockState.requestOptions.push(requestOptions);
          if (mistralMockState.streamResult !== undefined) {
            return mistralMockState.streamResult;
          }
          throw mistralMockState.streamError;
        }),
      };
    },
  };
});

import { streamMistral, streamSimpleMistral } from "./mistral.js";

function makeMistralModel(): Model<"mistral-conversations"> {
  return {
    id: "mistral-large-latest",
    name: "Mistral Large",
    api: "mistral-conversations",
    provider: "mistral",
    baseUrl: "https://api.mistral.ai",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8192,
  };
}

const context = {
  messages: [{ role: "user", content: "hello", timestamp: 0 }],
} satisfies Context;

function makeUnreadableParameterTool() {
  const tool = {
    name: "broken_tool",
    description: "broken tool",
    parameters: { type: "object", properties: {} },
    async execute() {
      return { content: [{ type: "text", text: "broken" }] };
    },
  };
  Object.defineProperty(tool, "parameters", {
    enumerable: true,
    get() {
      throw new Error("fuzzplugin parameters getter exploded");
    },
  });
  return tool;
}

function makeHealthyParameterTool(properties: Record<string, unknown> = {}) {
  return {
    name: "healthy_tool",
    description: "healthy tool",
    parameters: { type: "object", properties },
    async execute() {
      return { content: [{ type: "text", text: "ok" }] };
    },
  };
}

type NativeMistralToolCall = Extract<ReturnType<typeof toolCallFromJSON>, { ok: true }>["value"];

function parseNativeMistralToolCalls(fixtures: Record<string, unknown>[]) {
  return fixtures.map((fixture): NativeMistralToolCall => {
    const parsed = toolCallFromJSON(JSON.stringify(fixture));
    if (!parsed.ok) {
      throw new Error("Mistral SDK failed to parse tool-call fixtures");
    }
    return parsed.value;
  });
}

function setMistralToolCallStream(
  responseId: string,
  frames: ReadonlyArray<ReadonlyArray<NativeMistralToolCall | Record<string, unknown>>>,
  distinctFrameIds = false,
) {
  mistralMockState.streamResult = {
    async *[Symbol.asyncIterator]() {
      for (const [index, toolCalls] of frames.entries()) {
        yield {
          data: {
            id: distinctFrameIds ? `${responseId}-${index}` : responseId,
            model: "mistral-large-latest",
            choices: [
              {
                finishReason: "tool_calls",
                delta: { content: null, toolCalls },
              },
            ],
          },
        };
      }
    },
  };
}

type MistralNativeToolCase = {
  name: string;
  responseId: string;
  initial: Record<string, unknown>[];
  continuation?: Record<string, unknown>[];
  decodedInitial?: Record<string, unknown>[];
  decodedContinuation?: Record<string, unknown>[];
  expectedCalls?: Record<string, unknown>[];
  uuid?: string;
  error?: string;
  uniqueIds?: boolean;
  generatedIds?: boolean;
  distinctFrameIds?: boolean;
};

describe("Mistral provider", () => {
  beforeEach(() => {
    mistralMockState.configs = [];
    mistralMockState.payloads = [];
    mistralMockState.requestOptions = [];
    mistralMockState.randomUUIDs = [];
    mistralMockState.streamError = new Error("stop before network");
    mistralMockState.streamResult = undefined;
  });

  afterEach(() => {
    configureAiTransportHost({});
  });

  it("forwards simple stop sequences to Mistral stop", async () => {
    const stream = streamSimpleMistral(makeMistralModel(), context, {
      apiKey: "sk-mistral-provider",
      stop: ["STOP"],
    });

    const result = await stream.result();

    expect(result.stopReason).toBe("error");
    expect((mistralMockState.payloads[0] as { stop?: unknown }).stop).toEqual(["STOP"]);
  });

  it("keeps truncated Mistral error bodies UTF-16 safe with an exact omitted count", async () => {
    const prefix = "a".repeat(3_999);
    mistralMockState.streamError = Object.assign(new Error("invalid request"), {
      statusCode: 400,
      body: `${prefix}😀tail`,
    });

    const result = await streamMistral(makeMistralModel(), context, {
      apiKey: "sk-mistral-provider",
    }).result();

    expect(result.errorMessage).toBe(`Mistral API error (400): ${prefix}... [truncated 6 chars]`);
  });

  it("routes the Mistral HTTPClient through the host guarded fetch", async () => {
    const hostFetch = vi.fn<typeof fetch>(async () => new Response("guarded"));
    configureAiTransportHost({ buildModelFetch: () => hostFetch });

    await streamMistral(makeMistralModel(), context, { apiKey: "sentinel-key" }).result();

    const config = mistralMockState.configs[0] as {
      apiKey?: string;
      httpClient?: { request(request: Request): Promise<Response> };
    };
    expect(config.apiKey).toBe("sentinel-key");
    const response = await config.httpClient?.request(new Request("https://api.mistral.ai/chat"));
    expect(await response?.text()).toBe("guarded");
    expect(hostFetch).toHaveBeenCalledTimes(1);
  });

  it("uses reasoning effort for Mistral Medium 3.5", async () => {
    const stream = streamSimpleMistral(
      {
        ...makeMistralModel(),
        id: "mistral-medium-3-5",
        name: "Mistral Medium 3.5",
        reasoning: true,
      },
      context,
      {
        apiKey: "sk-mistral-provider",
        reasoning: "high",
      },
    );

    const result = await stream.result();
    const payload = mistralMockState.payloads[0] as Record<string, unknown>;

    expect(result.stopReason).toBe("error");
    expect(payload.reasoningEffort).toBe("high");
    expect(payload).not.toHaveProperty("promptMode");
  });

  it("skips unreadable tool schemas while preserving healthy Mistral tools", async () => {
    const stream = streamMistral(
      makeMistralModel(),
      {
        ...context,
        tools: [
          makeUnreadableParameterTool(),
          makeHealthyParameterTool({ query: { type: "string" } }),
        ] as never,
      },
      {
        apiKey: "sk-mistral-provider",
      },
    );

    const result = await stream.result();

    expect(result.stopReason).toBe("error");
    expect((mistralMockState.payloads[0] as { tools?: unknown[] }).tools).toEqual([
      {
        type: "function",
        function: {
          name: "healthy_tool",
          description: "healthy tool",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string" },
            },
          },
          strict: false,
        },
      },
    ]);
  });

  it("omits tools and automatic tool choice when every schema is unreadable", async () => {
    const stream = streamMistral(
      makeMistralModel(),
      {
        ...context,
        tools: [makeUnreadableParameterTool()] as never,
      },
      {
        apiKey: "sk-mistral-provider",
        toolChoice: "auto",
      },
    );

    const result = await stream.result();
    const payload = mistralMockState.payloads[0] as Record<string, unknown>;

    expect(result.stopReason).toBe("error");
    expect(payload).not.toHaveProperty("tools");
    expect(payload).not.toHaveProperty("toolChoice");
  });

  it("keeps omitted streamed tool ids stable within a response and unique across responses", async () => {
    mistralMockState.randomUUIDs = [
      "00000000-0000-4000-8000-000000429244",
      "00000000-0000-4000-8000-000000429245",
    ];
    const responseIds: string[][] = [];
    for (const responseId of ["response-a", "response-b"]) {
      setMistralToolCallStream(responseId, [
        [
          { index: 0, id: "null", function: { name: "computer", arguments: '{"step"' } },
          {
            index: 1,
            id: responseId === "response-a" ? "explicitA" : "explicitB",
            function: { name: "computer", arguments: '{"other"' },
          },
        ],
        [
          { index: 0, function: { name: "", arguments: ":1}" } },
          { index: 1, function: { name: "", arguments: ":true}" } },
        ],
      ]);
      const result = await streamMistral(makeMistralModel(), context, {
        apiKey: "sk-mistral-provider",
      }).result();
      const toolCalls = result.content.filter((block) => block.type === "toolCall");
      expect(toolCalls).toHaveLength(2);
      expect(toolCalls[0]?.arguments).toEqual({ step: 1 });
      expect(toolCalls[1]?.arguments).toEqual({ other: true });
      responseIds.push(toolCalls.map((toolCall) => toolCall.id));
    }

    expect(responseIds.flat().every((id) => /^[a-zA-Z0-9]{9}$/.test(id))).toBe(true);
    expect(responseIds[0]?.[1]).toBe("explicitA");
    expect(responseIds[1]?.[1]).toBe("explicitB");
    expect(responseIds[1]?.[0]).not.toBe(responseIds[0]?.[0]);
  });

  const nativeToolCases: MistralNativeToolCase[] = [
    {
      name: "keeps explicit streamed tool calls distinct when index is omitted",
      responseId: "response-unindexed",
      initial: [
        { id: "explicitA", function: { name: "first_tool", arguments: '{"value"' } },
        { id: "explicitB", function: { name: "second_tool", arguments: '{"value"' } },
      ],
      continuation: [
        { function: { name: "first_tool", arguments: ":1}" } },
        { function: { name: "second_tool", arguments: ":2}" } },
      ],
      decodedInitial: [{ index: 0 }, { index: 0 }],
      expectedCalls: [
        { id: "explicitA", name: "first_tool", arguments: { value: 1 } },
        { id: "explicitB", name: "second_tool", arguments: { value: 2 } },
      ],
    },
    {
      name: "keeps missing-id streamed tool calls distinct when index is omitted",
      responseId: "response-unidentified",
      uuid: "00000000-0000-4000-8000-000000429246",
      initial: [
        { function: { name: "first_tool", arguments: '{"value"' } },
        { index: 1, function: { name: "second_tool", arguments: '{"value"' } },
      ],
      continuation: [
        { function: { name: "first_tool", arguments: ":1}" } },
        { function: { name: "second_tool", arguments: ":2}" } },
      ],
      decodedInitial: [
        { id: "null", index: 0 },
        { id: "null", index: 1 },
      ],
      decodedContinuation: [{}, { id: "null", index: 0 }],
      expectedCalls: [
        { name: "first_tool", arguments: { value: 1 } },
        { name: "second_tool", arguments: { value: 2 } },
      ],
      uniqueIds: true,
      generatedIds: true,
    },
    {
      name: "routes an asymmetric omitted-index continuation by its persistent function name",
      responseId: "response-asymmetric-unindexed",
      uuid: "00000000-0000-4000-8000-000000429247",
      initial: [
        { function: { name: "first_tool", arguments: '{"value":1}' } },
        { index: 1, function: { name: "second_tool", arguments: '{"value"' } },
      ],
      continuation: [{ function: { name: "second_tool", arguments: ":2}" } }],
      decodedInitial: [
        { id: "null", index: 0 },
        { id: "null", index: 1 },
      ],
      decodedContinuation: [{ id: "null", index: 0 }],
      expectedCalls: [
        { name: "first_tool", arguments: { value: 1 } },
        { name: "second_tool", arguments: { value: 2 } },
      ],
    },
    {
      name: "rejects an ambiguous idless and nameless omitted-index continuation",
      responseId: "response-ambiguous-unindexed",
      uuid: "00000000-0000-4000-8000-000000429248",
      initial: [
        { function: { name: "first_tool", arguments: '{"value"' } },
        { function: { name: "second_tool", arguments: '{"value"' } },
      ],
      continuation: [{ function: { name: "", arguments: ":2}" } }],
      error: "tool-call continuation is ambiguous",
    },
    {
      name: "keeps same-name omitted-index siblings distinct and rejects their ambiguous continuation",
      responseId: "response-same-name-unindexed",
      uuid: "00000000-0000-4000-8000-000000429249",
      initial: [
        { function: { name: "computer", arguments: '{"step"' } },
        { function: { name: "computer", arguments: '{"step"' } },
      ],
      continuation: [{ function: { name: "computer", arguments: ":2}" } }],
      error: "tool-call continuation is ambiguous",
      uniqueIds: true,
    },
    {
      name: "keeps a later same-name call distinct when it has a nonzero index",
      responseId: "response-same-name-indexed",
      uuid: "00000000-0000-4000-8000-000000429250",
      initial: [
        { index: 0, function: { name: "computer", arguments: '{"step":1}' } },
        { index: 1, function: { name: "computer", arguments: '{"step":2}' } },
      ],
      expectedCalls: [
        { name: "computer", arguments: { step: 1 } },
        { name: "computer", arguments: { step: 2 } },
      ],
      uniqueIds: true,
      distinctFrameIds: true,
    },
  ];

  it.each(nativeToolCases)("$name", async (testCase) => {
    if (testCase.uuid) {
      mistralMockState.randomUUIDs = [testCase.uuid];
    }
    const initial = parseNativeMistralToolCalls(testCase.initial);
    const continuation = parseNativeMistralToolCalls(testCase.continuation ?? []);
    if (testCase.decodedInitial) {
      expect(initial).toMatchObject(testCase.decodedInitial);
    }
    if (testCase.decodedContinuation) {
      expect(continuation).toMatchObject(testCase.decodedContinuation);
    }
    const frames = testCase.distinctFrameIds
      ? initial.map((toolCall) => [toolCall])
      : [initial, ...(continuation.length ? [continuation] : [])];
    setMistralToolCallStream(testCase.responseId, frames, testCase.distinctFrameIds);

    const result = await streamMistral(makeMistralModel(), context, {
      apiKey: "sk-mistral-provider",
    }).result();
    const toolCalls = result.content.filter((block) => block.type === "toolCall");
    if (testCase.expectedCalls) {
      expect(toolCalls).toMatchObject(testCase.expectedCalls);
    }
    if (testCase.uniqueIds) {
      const ids = toolCalls.map((toolCall) => toolCall.id);
      expect(ids).toHaveLength(2);
      expect(new Set(ids).size).toBe(2);
      if (testCase.generatedIds) {
        expect(ids.every((id) => /^[a-zA-Z0-9]{9}$/.test(id))).toBe(true);
      }
    }
    if (testCase.error) {
      expect(result.stopReason).toBe("error");
      expect(result.errorMessage).toContain(testCase.error);
    }
  });

  it("fails locally when a pinned Mistral tool choice is skipped", async () => {
    const stream = streamMistral(
      makeMistralModel(),
      {
        ...context,
        tools: [makeUnreadableParameterTool(), makeHealthyParameterTool()] as never,
      },
      {
        apiKey: "sk-mistral-provider",
        toolChoice: { type: "function", function: { name: "broken_tool" } },
      },
    );

    const result = await stream.result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain(
      'Mistral tool_choice requested unavailable tool "broken_tool"',
    );
    expect(mistralMockState.payloads).toHaveLength(0);
  });

  it("validates and emits one snapshot of a pinned Mistral tool name", async () => {
    let nameReads = 0;
    const stream = streamMistral(
      makeMistralModel(),
      {
        ...context,
        tools: [makeHealthyParameterTool()] as never,
      },
      {
        apiKey: "sk-mistral-provider",
        toolChoice: {
          type: "function",
          function: {
            get name() {
              nameReads += 1;
              return nameReads === 1 ? "healthy_tool" : "broken_tool";
            },
          },
        },
      },
    );

    const result = await stream.result();

    expect(result.stopReason).toBe("error");
    expect(nameReads).toBe(1);
    expect((mistralMockState.payloads[0] as { toolChoice?: unknown }).toolChoice).toEqual({
      type: "function",
      function: { name: "healthy_tool" },
    });
  });

  it("strips the internal cache boundary marker from the system message", async () => {
    const stream = streamSimpleMistral(
      makeMistralModel(),
      {
        systemPrompt: `Stable${SYSTEM_PROMPT_CACHE_BOUNDARY}Dynamic`,
        messages: [{ role: "user", content: "hello", timestamp: 0 }],
      },
      { apiKey: "sk-mistral-provider" },
    );

    await stream.result();

    const payload = mistralMockState.payloads[0] as {
      messages: Array<{ role: string; content: string }>;
    };
    const systemMessage = payload.messages.find((message) => message.role === "system");
    expect(systemMessage?.content).toBe("Stable\nDynamic");
    expect(JSON.stringify(payload)).not.toContain("OPENCLAW_CACHE_BOUNDARY");
  });

  it("uses prompt cache affinity unless caching is disabled", async () => {
    for (const cacheRetention of [undefined, "none"] as const) {
      mistralMockState.payloads = [];
      mistralMockState.requestOptions = [];
      await streamSimpleMistral(makeMistralModel(), context, {
        apiKey: "fixture",
        sessionId: "session-affinity",
        promptCacheKey: "prompt-cache-key",
        ...(cacheRetention ? { cacheRetention } : {}),
      }).result();

      const payload = mistralMockState.payloads[0] as { promptCacheKey?: string };
      const requestOptions = mistralMockState.requestOptions[0] as {
        headers?: Record<string, string>;
      };
      if (cacheRetention === "none") {
        expect(payload.promptCacheKey).toBeUndefined();
        expect(requestOptions.headers?.["x-affinity"]).toBeUndefined();
      } else {
        expect(payload.promptCacheKey).toBe("prompt-cache-key");
        expect(requestOptions.headers?.["x-affinity"]).toBe("session-affinity");
      }
    }
  });

  it("uses the session id as the prompt cache key when no dedicated key is supplied", async () => {
    await streamSimpleMistral(makeMistralModel(), context, {
      apiKey: "fixture",
      sessionId: "session-cache-key",
    }).result();

    expect((mistralMockState.payloads[0] as { promptCacheKey?: string }).promptCacheKey).toBe(
      "session-cache-key",
    );
  });

  it.each([
    ["SDK camel case", { promptTokensDetails: { cachedTokens: 64 } }],
    ["wire snake case", { prompt_tokens_details: { cached_tokens: 64 } }],
  ])("accounts for cached prompt tokens from %s usage", async (_label, cacheUsage) => {
    mistralMockState.streamResult = {
      async *[Symbol.asyncIterator]() {
        yield {
          data: {
            id: "response-cache-usage",
            model: "mistral-small-latest",
            usage: {
              promptTokens: 100,
              completionTokens: 10,
              totalTokens: 110,
              ...cacheUsage,
            },
            choices: [
              {
                finishReason: "stop",
                delta: { content: "ok", toolCalls: [] },
              },
            ],
          },
        };
      },
    };

    const result = await streamMistral(makeMistralModel(), context, {
      apiKey: "fixture",
    }).result();

    expect(result.usage).toMatchObject({
      input: 36,
      output: 10,
      cacheRead: 64,
      cacheWrite: 0,
      totalTokens: 110,
    });
  });

  const toolResultCases: Array<{
    name: string;
    toolName: string;
    content: Record<string, unknown>[];
    expectedText: string;
    excluded: string[];
    redact?: boolean;
    image?: boolean;
  }> = [
    {
      name: "serializes structured non-image blocks in tool results as JSON text",
      toolName: "fetch",
      content: [
        {
          type: "resource",
          resource: {
            uri: "https://example.com/data.json",
            mimeType: "application/json",
            text: '{"key":"value"}',
          },
        },
      ],
      expectedText: '{"type":"resource"',
      excluded: ['\\"key\\":\\"value\\"'],
      redact: true,
    },
    {
      name: "does not emit image chunks or placeholders for payload-less tool media",
      toolName: "screenshot",
      content: [{ type: "image", mimeType: "image/png", data: "" }],
      expectedText: "(no tool output)",
      excluded: ["image_url", "see attached image"],
      image: true,
    },
    {
      name: "serializes structured-only tool results instead of empty fallback",
      toolName: "get_file",
      content: [
        {
          type: "resource_link",
          uri: "https://example.com/file.txt",
          name: "file.txt",
          mimeType: "text/plain",
          size: 100,
        },
      ],
      expectedText: '{"type":"resource_link"',
      excluded: ["(no tool output)"],
    },
  ];

  it.each(toolResultCases)("$name", async (testCase) => {
    if (testCase.redact) {
      configureAiTransportHost({
        redactToolPayloadText: (text) => text.replaceAll('"value"', '"***"'),
      });
    }
    const toolCallId = testCase.image ? "tool_husk" : "tool_1";
    const testContext = {
      messages: [
        ...(testCase.image ? [] : [{ role: "user", content: "hello", timestamp: 1 }]),
        {
          role: "assistant",
          provider: "mistral",
          api: "mistral-conversations",
          model: "mistral-large-latest",
          stopReason: "toolUse",
          timestamp: 0,
          content: [{ type: "toolCall", id: toolCallId, name: testCase.toolName, arguments: {} }],
        },
        {
          role: "toolResult",
          toolCallId,
          ...(testCase.image ? { toolName: testCase.toolName } : {}),
          content: testCase.content,
          isError: false,
          timestamp: 0,
        },
      ],
    } as unknown as Context;
    const model = makeMistralModel();
    if (testCase.image) {
      model.input = ["text", "image"];
    }
    await streamMistral(model, testContext, {
      apiKey: testCase.image ? "fake" : "sk-mistral-provider",
    }).result();

    const payload = mistralMockState.payloads[0] as {
      messages: Array<{ role: string; content: string | Array<{ type: string; text?: string }> }>;
    };
    const toolMessage = payload.messages.find((message) => message.role === "tool");
    expect(toolMessage).toBeDefined();
    const content = Array.isArray(toolMessage?.content) ? toolMessage.content : [];
    const text = content.find((block) => block.type === "text")?.text;
    if (testCase.image) {
      expect(content).toEqual([{ type: "text", text: testCase.expectedText }]);
    } else {
      expect(text).toEqual(expect.stringContaining(testCase.expectedText));
    }
    if (testCase.redact) {
      expect(text).toContain('{\\"key\\":\\"***\\"}');
    }
    for (const excluded of testCase.excluded) {
      expect(testCase.image ? JSON.stringify(toolMessage) : text).not.toContain(excluded);
    }
  });
});
