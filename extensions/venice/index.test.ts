// Venice tests cover index plugin behavior.
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";

describe("venice provider plugin", () => {
  it("registers provider-owned usage hooks", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    expect(provider).toMatchObject({
      resolveUsageAuth: expect.any(Function),
      fetchUsageSnapshot: expect.any(Function),
    });
  });

  it("applies the shared xAI compat patch to Grok-backed Venice models only", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    expect(
      provider.normalizeResolvedModel?.({
        modelId: "venice/grok-4",
        model: {
          id: "grok-4",
          compat: {
            supportsUsageInStreaming: true,
          },
        },
      } as never),
    ).toEqual({
      id: "grok-4",
      compat: {
        supportsUsageInStreaming: true,
        toolSchemaProfile: "xai",
        unsupportedToolSchemaKeywords: [
          "minLength",
          "maxLength",
          "minItems",
          "maxItems",
          "minContains",
          "maxContains",
        ],
        toolCallArgumentsEncoding: "html-entities",
      },
    });

    expect(
      provider.normalizeResolvedModel?.({
        modelId: "venice/qwen3-coder-480b-a35b-instruct-turbo",
        model: {
          id: "qwen3-coder-480b-a35b-instruct-turbo",
          compat: {},
        },
      } as never),
    ).toBeUndefined();
  });

  it("fills missing DeepSeek V4 reasoning_content on Venice replay turns", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const capturedPayloads: Record<string, unknown>[] = [];
    const baseStreamFn = (_model: unknown, _context: unknown, options: unknown) => {
      const payload = {
        model: "deepseek-v4-pro",
        thinking: { type: "enabled" },
        reasoning_effort: "high",
        messages: [
          {
            role: "assistant",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "read", arguments: "{}" },
              },
            ],
          },
          { role: "assistant", content: "done" },
        ],
      };
      (options as { onPayload?: (payload: Record<string, unknown>) => void })?.onPayload?.(payload);
      capturedPayloads.push(payload);
      return {} as never;
    };

    const streamFn = provider.wrapStreamFn?.({
      streamFn: baseStreamFn as never,
      providerId: "venice",
      modelId: "deepseek-v4-pro",
      thinkingLevel: "high",
    } as never);

    expect(streamFn).toBeTypeOf("function");
    await streamFn?.({ provider: "venice", id: "deepseek-v4-pro" } as never, {} as never, {});

    expect(capturedPayloads).toEqual([
      {
        model: "deepseek-v4-pro",
        messages: [
          {
            role: "assistant",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "read", arguments: "{}" },
              },
            ],
            reasoning_content: "",
          },
          {
            role: "assistant",
            content: "done",
            reasoning_content: "",
          },
        ],
      },
    ]);
  });

  it("replays Gemini signatures and marks foreign history in Venice's top-level field", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const capturedPayloads: Record<string, unknown>[] = [];
    const baseStreamFn = (_model: unknown, _context: unknown, options: unknown) => {
      const payload = {
        model: "gemini-3-6-flash",
        messages: [
          { role: "user", content: "echo" },
          {
            role: "assistant",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "echo_value", arguments: '{"value":"repro"}' },
              },
            ],
          },
          { role: "tool", tool_call_id: "call_1", content: "ok" },
        ],
      };
      (options as { onPayload?: (payload: Record<string, unknown>) => void })?.onPayload?.(payload);
      capturedPayloads.push(payload);
      return {} as never;
    };

    const streamFn = provider.wrapStreamFn?.({
      streamFn: baseStreamFn as never,
      providerId: "venice",
      modelId: "gemini-3-6-flash",
      thinkingLevel: "high",
    } as never);

    expect(streamFn).toBeTypeOf("function");
    await streamFn?.(
      { api: "openai-completions", provider: "venice", id: "gemini-3-6-flash" } as never,
      {
        messages: [
          { role: "user", content: "echo" },
          {
            role: "assistant",
            api: "openai-completions",
            provider: "venice",
            model: "gemini-3-6-flash",
            content: [
              {
                type: "toolCall",
                id: "call_1",
                name: "echo_value",
                arguments: { value: "repro" },
                thoughtSignature: "SIG-VENICE-OPAQUE-ABC==",
              },
            ],
          },
          {
            role: "toolResult",
            toolCallId: "call_1",
            toolName: "echo_value",
            content: [{ type: "text", text: "ok" }],
            isError: false,
          },
        ],
      } as never,
      {},
    );

    expect(capturedPayloads[0]).toMatchObject({
      messages: [
        { role: "user", content: "echo" },
        {
          role: "assistant",
          tool_calls: [
            {
              id: "call_1",
              thought_signature: "SIG-VENICE-OPAQUE-ABC==",
            },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "ok" },
      ],
    });
    const replayedToolCall = (
      (capturedPayloads[0]!.messages as Array<Record<string, unknown>>)[1]!.tool_calls as Array<
        Record<string, unknown>
      >
    )[0];
    expect(replayedToolCall).not.toHaveProperty("extra_content");

    await streamFn?.(
      { api: "openai-completions", provider: "venice", id: "gemini-3-6-flash" } as never,
      {
        messages: [
          {
            role: "assistant",
            api: "google-generative-ai",
            provider: "google",
            model: "gemini-3-6-flash",
            content: [
              {
                type: "toolCall",
                id: "call_1",
                name: "echo_value",
                arguments: {},
                thoughtSignature: "SIG-CROSS-ROUTE",
              },
            ],
          },
        ],
      } as never,
      {},
    );
    const crossRouteToolCall = (
      (capturedPayloads[1]!.messages as Array<Record<string, unknown>>)[1]!.tool_calls as Array<
        Record<string, unknown>
      >
    )[0];
    expect(crossRouteToolCall).toMatchObject({
      thought_signature: "skip_thought_signature_validator",
    });
  });

  it("marks unsigned mixed-model and parallel Gemini history for validation bypass", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    let capturedPayload: Record<string, unknown> | undefined;
    const baseStreamFn = (_model: unknown, _context: unknown, options: unknown) => {
      const payload = {
        model: "gemini-3-6-flash",
        messages: [
          {
            role: "assistant",
            tool_calls: [
              { id: "foreign_call", type: "function", function: { name: "web_fetch" } },
              { id: "legacy_call", type: "function", function: { name: "read" } },
              { id: "signed_call", type: "function", function: { name: "read" } },
            ],
          },
        ],
      };
      (options as { onPayload?: (payload: Record<string, unknown>) => void })?.onPayload?.(payload);
      capturedPayload = payload;
      return {} as never;
    };
    const streamFn = provider.wrapStreamFn?.({
      streamFn: baseStreamFn as never,
      providerId: "venice",
      modelId: "gemini-3-6-flash",
      thinkingLevel: "high",
    } as never);

    await streamFn?.(
      { api: "openai-completions", provider: "venice", id: "gemini-3-6-flash" } as never,
      {
        messages: [
          {
            role: "assistant",
            api: "openai-chatgpt-responses",
            provider: "openai",
            model: "gpt-5.6-sol",
            content: [{ type: "toolCall", id: "foreign_call", name: "web_fetch", arguments: {} }],
          },
          {
            role: "assistant",
            api: "openai-completions",
            provider: "venice",
            model: "gemini-3-6-flash",
            content: [
              { type: "toolCall", id: "legacy_call", name: "read", arguments: {} },
              {
                type: "toolCall",
                id: "signed_call",
                name: "read",
                arguments: {},
                thoughtSignature: "SIG-EXACT-SAME-ROUTE==",
              },
            ],
          },
        ],
      } as never,
      {},
    );

    const toolCalls = (capturedPayload!.messages as Array<Record<string, unknown>>)[0]!
      .tool_calls as Array<Record<string, unknown>>;
    expect(toolCalls.map((toolCall) => toolCall.thought_signature)).toEqual([
      "skip_thought_signature_validator",
      "skip_thought_signature_validator",
      "SIG-EXACT-SAME-ROUTE==",
    ]);
  });

  it("does not add the Gemini 3 validator bypass to unsigned Gemini 2.5 history", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    let capturedPayload: Record<string, unknown> | undefined;
    const baseStreamFn = (_model: unknown, _context: unknown, options: unknown) => {
      const payload = {
        model: "gemini-2.5-flash",
        messages: [
          {
            role: "assistant",
            tool_calls: [{ id: "call_1", type: "function", function: { name: "read" } }],
          },
        ],
      };
      (options as { onPayload?: (payload: Record<string, unknown>) => void })?.onPayload?.(payload);
      capturedPayload = payload;
      return {} as never;
    };
    const streamFn = provider.wrapStreamFn?.({
      streamFn: baseStreamFn as never,
      providerId: "venice",
      modelId: "gemini-2.5-flash",
      thinkingLevel: "high",
    } as never);

    await streamFn?.(
      { api: "openai-completions", provider: "venice", id: "gemini-2.5-flash" } as never,
      { messages: [] } as never,
      {},
    );

    const toolCall = (
      (capturedPayload!.messages as Array<Record<string, unknown>>)[0]!.tool_calls as Array<
        Record<string, unknown>
      >
    )[0];
    expect(toolCall).not.toHaveProperty("thought_signature");
  });
});
