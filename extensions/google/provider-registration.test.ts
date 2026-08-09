// Google tests cover provider registration plugin behavior.
import type { Model } from "openclaw/plugin-sdk/llm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildGoogleProvider } from "./provider-registration.js";

const streamFns = vi.hoisted(() => ({
  createGenerativeAi: vi.fn(() => vi.fn()),
  createVertex: vi.fn(() => vi.fn()),
}));

vi.mock("./transport-stream.js", () => ({
  createGoogleGenerativeAiTransportStreamFn: streamFns.createGenerativeAi,
  createGoogleVertexTransportStreamFn: streamFns.createVertex,
}));

function model(overrides: Partial<Model> = {}): Model {
  return {
    id: "gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    provider: "google-vertex",
    api: "google-generative-ai",
    baseUrl: "https://aiplatform.googleapis.com",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_048_576,
    maxTokens: 65_536,
    ...overrides,
  } as Model;
}

describe("buildGoogleProvider createStreamFn", () => {
  beforeEach(() => {
    streamFns.createGenerativeAi.mockClear();
    streamFns.createVertex.mockClear();
  });

  it("routes native Vertex hosts through the Vertex transport", () => {
    const provider = buildGoogleProvider();

    provider.createStreamFn?.({
      provider: "google-vertex",
      modelId: "gemini-2.5-flash",
      model: model(),
    } as never);

    expect(streamFns.createVertex).toHaveBeenCalledTimes(1);
    expect(streamFns.createGenerativeAi).not.toHaveBeenCalled();
  });

  it("preserves explicit OpenAI-compatible Vertex endpoint configs", () => {
    const provider = buildGoogleProvider();

    const result = provider.createStreamFn?.({
      provider: "google-vertex",
      modelId: "gemini-2.5-flash",
      model: model({
        api: "openai-completions",
        baseUrl:
          "https://aiplatform.googleapis.com/v1/projects/test/locations/us-central1/endpoints/openapi",
      }),
    } as never);

    expect(result).toBeUndefined();
    expect(streamFns.createVertex).not.toHaveBeenCalled();
    expect(streamFns.createGenerativeAi).not.toHaveBeenCalled();
  });
});

describe("buildGoogleProvider native video contract", () => {
  const normalize = (overrides: Partial<Model> = {}, provider = "google") =>
    buildGoogleProvider().normalizeResolvedModel?.({
      provider,
      modelId: overrides.id ?? "gemini-2.5-flash",
      model: model({
        provider,
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        input: ["text", "image", "video"],
        ...overrides,
      }),
    } as never);

  it("attaches the bounded AI Studio ordinary-chat contract", () => {
    expect(normalize()).toMatchObject({
      nativeVideoInput: {
        wireFamily: "google-inline-data",
        maxDecodedBytesPerItem: 8 * 1024 * 1024,
        maxItems: 4,
        maxAggregateDecodedBytes: 12 * 1024 * 1024,
        aggregateScope: "all-inline-media",
        maxSerializedRequestBytesExclusive: 20_000_000,
      },
    });
  });

  it.each([
    ["Vertex", { api: "google-vertex" }, "google-vertex"],
    ["CLI", { api: "google-gemini-cli" }, "google-gemini-cli"],
    ["Computer Use", { id: "gemini-2.5-computer-use-preview-10-2025" }, "google"],
    ["Gemma", { id: "gemma-3-27b-it" }, "google"],
    ["custom proxy", { baseUrl: "https://proxy.example.test/v1beta" }, "google"],
    [
      "query-bearing AI Studio URL",
      { baseUrl: "https://generativelanguage.googleapis.com/v1beta?key=inline" },
      "google",
    ],
    [
      "credential-bearing AI Studio URL",
      { baseUrl: "https://user" + ":secret@generativelanguage.googleapis.com/v1beta" },
      "google",
    ],
  ] as const)("does not attach native video for %s", (_label, overrides, provider) => {
    expect(normalize(overrides as Partial<Model>, provider)).not.toHaveProperty("nativeVideoInput");
  });
});
