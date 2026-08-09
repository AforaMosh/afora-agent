import type { NativeVideoInputContract } from "openclaw/plugin-sdk/llm";
// Moonshot plugin entrypoint registers its OpenClaw integration.
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { buildOpenAICompatibleReplayPolicy } from "openclaw/plugin-sdk/provider-model-shared";
import { buildProviderStreamFamilyHooks } from "openclaw/plugin-sdk/provider-stream-family";
import { applyMoonshotNativeStreamingUsageCompat, isNativeMoonshotBaseUrl } from "./api.js";
import { moonshotMediaUnderstandingProvider } from "./media-understanding-provider.js";
import { applyMoonshotConfig, applyMoonshotConfigCn } from "./onboard.js";
import { buildMoonshotProvider, MOONSHOT_DEFAULT_MODEL_REF } from "./provider-catalog.js";
import { isMoonshotAlwaysThinkingModelId, resolveThinkingProfile } from "./provider-policy-api.js";
import { createKimiWebSearchProvider } from "./src/kimi-web-search-provider.js";

const PROVIDER_ID = "moonshot";
const moonshotThinkingStreamHooks = buildProviderStreamFamilyHooks("moonshot-thinking");

const MOONSHOT_NATIVE_VIDEO_INPUT = {
  wireFamily: "openai-chat-video-url",
  mimeTypes: {
    "video/mp4": "video/mp4",
    "video/mpeg": "video/mpeg",
    "video/mov": "video/mov",
    "video/quicktime": "video/mov",
    "video/avi": "video/avi",
    "video/x-msvideo": "video/avi",
    "video/x-flv": "video/x-flv",
    "video/mpg": "video/mpg",
    "video/webm": "video/webm",
    "video/wmv": "video/wmv",
    "video/x-ms-wmv": "video/wmv",
    "video/3gpp": "video/3gpp",
  },
  maxDecodedBytesPerItem: 16 * 1024 * 1024,
  maxItems: 4,
  maxAggregateDecodedBytes: 48 * 1024 * 1024,
  aggregateScope: "video",
  maxSerializedRequestBytesExclusive: 100_000_000,
} as const satisfies NativeVideoInputContract;

function hasCleanMoonshotBaseUrl(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "Moonshot Provider",
  description: "Bundled Moonshot provider plugin",
  provider: {
    label: "Moonshot",
    docsPath: "/providers/moonshot",
    aliases: ["moonshotai", "moonshot-ai"],
    auth: [
      {
        methodId: "api-key",
        label: "Kimi API key (.ai)",
        hint: "Kimi API models · https://platform.kimi.ai/docs/pricing/chat",
        optionKey: "moonshotApiKey",
        flagName: "--moonshot-api-key",
        envVar: "MOONSHOT_API_KEY",
        promptMessage: "Enter Moonshot API key",
        defaultModel: MOONSHOT_DEFAULT_MODEL_REF,
        applyConfig: (cfg) => applyMoonshotConfig(cfg),
        wizard: {
          groupLabel: "Moonshot AI (Kimi)",
        },
      },
      {
        methodId: "api-key-cn",
        label: "Kimi API key (.cn)",
        hint: "Kimi API models · https://platform.kimi.ai/docs/pricing/chat",
        optionKey: "moonshotApiKey",
        flagName: "--moonshot-api-key",
        envVar: "MOONSHOT_API_KEY",
        promptMessage: "Enter Moonshot API key (.cn)",
        defaultModel: MOONSHOT_DEFAULT_MODEL_REF,
        applyConfig: (cfg) => applyMoonshotConfigCn(cfg),
        wizard: {
          groupLabel: "Moonshot AI (Kimi)",
        },
      },
    ],
    catalog: {
      buildProvider: buildMoonshotProvider,
      buildStaticProvider: buildMoonshotProvider,
      allowExplicitBaseUrl: true,
      liveModelDiscovery: true,
    },
    applyNativeStreamingUsageCompat: ({ providerConfig }) =>
      applyMoonshotNativeStreamingUsageCompat(providerConfig),
    normalizeResolvedModel: (ctx) => {
      const { nativeVideoInput: _ignored, ...model } = ctx.model;
      const modelId = ctx.modelId.replace(/^moonshot\//u, "").toLowerCase();
      return ctx.provider === PROVIDER_ID &&
        modelId === "kimi-k3" &&
        model.api === "openai-completions" &&
        isNativeMoonshotBaseUrl(model.baseUrl) &&
        hasCleanMoonshotBaseUrl(model.baseUrl)
        ? { ...model, nativeVideoInput: MOONSHOT_NATIVE_VIDEO_INPUT }
        : model;
    },
    buildReplayPolicy: ({ modelApi, modelId }) =>
      buildOpenAICompatibleReplayPolicy(modelApi, {
        modelId,
        sanitizeToolCallIds: modelApi === "openai-completions",
        duplicateToolCallIdStyle: "openai",
        dropReasoningFromHistory: false,
      }),
    ...moonshotThinkingStreamHooks,
    wrapSimpleCompletionStreamFn: (ctx) =>
      isMoonshotAlwaysThinkingModelId(ctx.modelId)
        ? moonshotThinkingStreamHooks.wrapStreamFn?.(ctx)
        : ctx.streamFn,
    resolveThinkingProfile,
    isModernModelRef: ({ modelId }) => isMoonshotAlwaysThinkingModelId(modelId),
  },
  register(api) {
    api.registerMediaUnderstandingProvider(moonshotMediaUnderstandingProvider);
    api.registerWebSearchProvider(createKimiWebSearchProvider());
  },
});
