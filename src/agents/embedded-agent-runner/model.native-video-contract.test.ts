import { supportsNativeVideoInput } from "@openclaw/llm-core";
import { describe, expect, it } from "vitest";
import type { Model } from "../../llm/types.js";
import { normalizeResolvedModel, type ProviderRuntimeHooks } from "./model.provider-hooks.js";

const model = {
  id: "video-model",
  name: "Video model",
  api: "openai-completions",
  provider: "test",
  baseUrl: "https://example.test/v1",
  reasoning: false,
  input: ["text", "video"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4_096,
  nativeVideoInput: undefined,
} satisfies Model;

const contract = {
  wireFamily: "openai-chat-video-url",
  mimeTypes: { "video/mp4": "video/mp4" },
  maxDecodedBytesPerItem: 1,
  maxItems: 1,
  maxAggregateDecodedBytes: 1,
  aggregateScope: "video",
  maxSerializedRequestBytesExclusive: 100,
} as const;

function hooks(normalize: ProviderRuntimeHooks["normalizeProviderResolvedModelWithPlugin"]) {
  return {
    applyProviderResolvedTransportWithPlugin: () => undefined,
    buildProviderUnknownModelHintWithPlugin: () => undefined,
    prepareProviderDynamicModel: async () => {},
    runProviderDynamicModel: () => undefined,
    normalizeProviderResolvedModelWithPlugin: normalize,
    normalizeProviderTransportWithPlugin: () => undefined,
  } satisfies ProviderRuntimeHooks;
}

describe("prepared native video contract", () => {
  it("derives effective support from the final provider hook result, not raw model.input", () => {
    expect(supportsNativeVideoInput(model)).toBe(false);
    const prepared = normalizeResolvedModel({
      provider: "test",
      model,
      runtimeHooks: hooks(({ context }) => ({ ...context.model, nativeVideoInput: contract })),
    });
    expect(prepared.nativeVideoInput).toBe(contract);
    expect(supportsNativeVideoInput(prepared)).toBe(true);
  });
});
