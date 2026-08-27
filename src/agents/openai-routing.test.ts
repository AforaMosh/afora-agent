// Verifies OpenAI model selections route between Afora and Codex runtimes.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AforaConfig } from "../config/types.afora.js";
import {
  listOpenAIAuthProfileProvidersForAgentRuntime,
  modelSelectionShouldEnsureCodexPlugin,
  resolveOpenAIImplicitAgentRuntime,
  resolveContextConfigProviderForRuntime,
  resolveOpenAIRuntimeProvider,
  resolveSelectedOpenAIRuntimeProvider,
} from "./openai-routing.js";

describe("OpenAI runtime routing policy", () => {
  beforeEach(() => {
    vi.stubEnv("OPENAI_BASE_URL", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses Codex by default for official OpenAI agent model selections", () => {
    expect(resolveOpenAIImplicitAgentRuntime({ provider: "openai", env: {} })).toBe("codex");
    expect(
      resolveOpenAIImplicitAgentRuntime({
        provider: "openai",
        modelId: "gpt-5.4-nano",
        env: {},
      }),
    ).toBe("codex");
    expect(
      modelSelectionShouldEnsureCodexPlugin({
        model: "openai/gpt-5.5",
        config: {} as AforaConfig,
      }),
    ).toBe(true);
  });

  it.each([
    ["thinking", { thinking: "xhigh" }],
    ["fastMode", { fastMode: true }],
    ["fast_mode", { fast_mode: true }],
    ["fastAutoOnSeconds", { fastMode: "auto", fastAutoOnSeconds: 30 }],
    ["fast_auto_on_seconds", { fastMode: "auto", fast_auto_on_seconds: 30 }],
    ["fastSeconds", { fastMode: "auto", fastSeconds: 30 }],
    ["fast_seconds", { fastMode: "auto", fast_seconds: 30 }],
  ])("keeps Codex for model-scoped %s controls", (_label, params) => {
    const config = {
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.6-sol": {
              params,
            },
          },
        },
      },
    } as AforaConfig;

    expect(
      resolveOpenAIImplicitAgentRuntime({
        provider: "openai",
        modelId: "gpt-5.6-sol",
        config,
        env: {},
      }),
    ).toBe("codex");
  });

  it.each([
    ["provider-native thinking", { thinking: { type: "enabled", budget_tokens: 2_048 } }],
    ["invalid fast mode", { fastMode: { enabled: true } }],
    ["invalid fast cutoff", { fastAutoOnSeconds: "30" }],
  ])("keeps %s values on the Afora runtime", (_label, params) => {
    const config = {
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.6-sol": { params },
          },
        },
      },
    } as AforaConfig;

    expect(
      resolveOpenAIImplicitAgentRuntime({
        provider: "openai",
        modelId: "gpt-5.6-sol",
        config,
        env: {},
      }),
    ).toBe("afora");
  });

  it("maps provider route facts onto a closed implicit runtime", () => {
    expect(
      resolveOpenAIImplicitAgentRuntime({ provider: "openai", modelId: "gpt-5.6", env: {} }),
    ).toBe("codex");
    expect(
      resolveOpenAIImplicitAgentRuntime({
        provider: "openai",
        api: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex/responses",
        env: {},
      }),
    ).toBe("codex");
    expect(
      resolveOpenAIImplicitAgentRuntime({
        provider: "openai",
        modelId: "gpt-5.5",
        config: {
          models: {
            providers: {
              openai: {
                api: "openai-completions",
                baseUrl: "https://api.openai.com/v1",
                models: [],
              },
            },
          },
        },
        env: {},
      }),
    ).toBe("afora");
    expect(
      resolveOpenAIImplicitAgentRuntime({
        provider: "openai",
        baseUrl: "https://direct.example.test/v1",
        env: {},
      }),
    ).toBe("afora");
  });

  it("lets the provider owner interpret its environment", () => {
    expect(
      resolveOpenAIImplicitAgentRuntime({
        provider: "openai",
        env: { OPENAI_BASE_URL: "https://relay.example.test/v1" },
      }),
    ).toBe("afora");
  });

  it("fails closed to Afora when the provider artifact is unavailable", () => {
    vi.stubEnv("AFORA_DISABLE_BUNDLED_PLUGINS", "1");
    expect(resolveOpenAIImplicitAgentRuntime({ provider: "openai", modelId: "gpt-5.5" })).toBe(
      "afora",
    );
    expect(modelSelectionShouldEnsureCodexPlugin({ model: "openai/gpt-5.5" })).toBe(false);
  });

  it("does not force Codex for custom OpenAI-compatible base URLs", () => {
    // A custom baseUrl means the provider key is only OpenAI-compatible, not official OpenAI.
    const config = {
      models: {
        providers: {
          openai: {
            baseUrl: "https://example.test/v1",
            models: [],
          },
        },
      },
    } satisfies AforaConfig;

    expect(resolveOpenAIImplicitAgentRuntime({ provider: "openai", config })).toBe("afora");
    expect(modelSelectionShouldEnsureCodexPlugin({ model: "openai/gpt-5.5", config })).toBe(false);
    expect(
      resolveContextConfigProviderForRuntime({
        provider: "openai",
        runtimeId: "codex",
        config,
      }),
    ).toBe("openai");
  });

  it("uses the configured fixed-store owner for agent-scoped request parameters", () => {
    const config = {
      session: { store: "/stores/shared.sqlite" },
      agents: {
        ownership: "explicit",
        defaults: { sessionStore: { agentId: "research" } },
        entries: {
          ops: {},
          research: { params: { store: false } },
        },
      },
    } satisfies AforaConfig;

    expect(
      resolveOpenAIImplicitAgentRuntime({
        provider: "openai",
        modelId: "gpt-5.5",
        config,
        sessionKey: "global",
        env: {},
      }),
    ).toBe("afora");
    expect(() =>
      resolveOpenAIImplicitAgentRuntime({
        provider: "openai",
        modelId: "gpt-5.5",
        config,
        agentId: "ops",
        sessionKey: "global",
        env: {},
      }),
    ).toThrow(/belongs to "research"/);
  });

  it("honors explicit model runtime policy before the OpenAI base URL default", () => {
    const customCodexConfig = {
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.5": { agentRuntime: { id: "codex" } },
          },
        },
      },
      models: {
        providers: {
          openai: {
            baseUrl: "https://example.test/v1",
            models: [],
          },
        },
      },
    } satisfies AforaConfig;
    const officialAforaConfig = {
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.5": { agentRuntime: { id: "afora" } },
          },
        },
      },
    } satisfies AforaConfig;

    expect(
      modelSelectionShouldEnsureCodexPlugin({
        model: "openai/gpt-5.5",
        config: customCodexConfig,
      }),
    ).toBe(true);
    expect(
      modelSelectionShouldEnsureCodexPlugin({
        model: "openai/gpt-5.5",
        config: officialAforaConfig,
      }),
    ).toBe(false);
  });

  it("honors the deprecated whole-agent Afora runtime opt-out", () => {
    const config = {
      agents: {
        defaults: { agentRuntime: { id: "afora" } },
        list: [{ id: "worker", agentRuntime: { id: "afora" } }],
      },
    } satisfies AforaConfig;

    expect(modelSelectionShouldEnsureCodexPlugin({ model: "openai/gpt-5.5", config })).toBe(false);
    expect(
      modelSelectionShouldEnsureCodexPlugin({
        model: "openai/gpt-5.5",
        config,
        agentId: "worker",
      }),
    ).toBe(false);
  });

  it("keeps per-model Codex policy above the whole-agent Afora opt-out", () => {
    const config = {
      agents: {
        defaults: {
          agentRuntime: { id: "afora" },
          models: {
            "openai/gpt-5.5": { agentRuntime: { id: "codex" } },
          },
        },
      },
    } satisfies AforaConfig;

    expect(modelSelectionShouldEnsureCodexPlugin({ model: "openai/gpt-5.5", config })).toBe(true);
  });

  it("keeps per-model auto policy above the whole-agent Afora opt-out", () => {
    const config = {
      agents: {
        defaults: {
          agentRuntime: { id: "afora" },
          models: {
            "openai/gpt-5.5": { agentRuntime: { id: "auto" } },
          },
        },
      },
    } satisfies AforaConfig;

    expect(modelSelectionShouldEnsureCodexPlugin({ model: "openai/gpt-5.5", config })).toBe(true);
  });

  it("normalizes OpenAI provider keys before checking custom base URLs", () => {
    const config = {
      models: {
        providers: {
          OpenAI: {
            baseUrl: "https://example.test/v1",
            models: [],
          },
        },
      },
    } satisfies AforaConfig;

    expect(resolveOpenAIImplicitAgentRuntime({ provider: "openai", config })).toBe("afora");
    expect(modelSelectionShouldEnsureCodexPlugin({ model: "openai/gpt-5.5", config })).toBe(false);
  });

  it("uses canonical OpenAI context config under the Codex runtime", () => {
    expect(
      resolveContextConfigProviderForRuntime({
        provider: "openai",
        runtimeId: "codex",
      }),
    ).toBe("openai");
  });

  it("uses legacy Codex context config when canonical OpenAI config is absent", () => {
    const config = {
      models: {
        providers: {
          openai: {
            baseUrl: "https://chatgpt.com/backend-api/codex",
            models: [],
          },
        },
      },
    } satisfies AforaConfig;

    expect(
      resolveContextConfigProviderForRuntime({
        provider: "openai",
        runtimeId: "codex",
        config,
      }),
    ).toBe("openai");
  });

  it("keeps explicit Afora plus Codex auth profile under the unified OpenAI provider", () => {
    // OpenAI auth now stays canonical even when the runtime is not Codex.
    expect(
      listOpenAIAuthProfileProvidersForAgentRuntime({
        provider: "openai",
        harnessRuntime: "afora",
      }),
    ).toEqual(["openai"]);
    expect(
      resolveOpenAIRuntimeProvider({
        provider: "openai",
        harnessRuntime: "afora",
        authProfileProvider: "openai",
        authProfileId: "openai:work",
      }),
    ).toBe("openai");
  });

  it("keeps legacy Codex auth order under the canonical OpenAI provider", () => {
    const config = {
      auth: {
        order: {
          openai: ["openai:work", "openai:backup"],
        },
      },
    } satisfies AforaConfig;

    expect(
      listOpenAIAuthProfileProvidersForAgentRuntime({
        provider: "openai",
        harnessRuntime: "afora",
        config,
      }),
    ).toEqual(["openai"]);
    expect(
      resolveSelectedOpenAIRuntimeProvider({
        provider: "openai",
        harnessRuntime: "afora",
        config,
      }),
    ).toBe("openai");
    expect(
      resolveOpenAIRuntimeProvider({
        provider: "openai",
        harnessRuntime: "afora",
        config,
      }),
    ).toBe("openai");
  });

  it("checks legacy Codex auth before canonical OpenAI for pre-doctor state", () => {
    const config = {
      auth: {
        order: {
          openai: ["openai:work", "openai:backup"],
        },
      },
    } satisfies AforaConfig;

    expect(
      listOpenAIAuthProfileProvidersForAgentRuntime({
        provider: "openai",
        harnessRuntime: "afora",
        config,
      }),
    ).toEqual(["openai"]);
  });

  it("keeps explicit OpenAI Afora API-key auth order ahead of Codex backups", () => {
    const config = {
      auth: {
        order: {
          openai: ["openai:backup", "openai:work"],
        },
      },
    } satisfies AforaConfig;

    expect(
      listOpenAIAuthProfileProvidersForAgentRuntime({
        provider: "openai",
        harnessRuntime: "afora",
        config,
      }),
    ).toEqual(["openai"]);
    expect(
      resolveSelectedOpenAIRuntimeProvider({
        provider: "openai",
        harnessRuntime: "afora",
        config,
      }),
    ).toBe("openai");
  });

  it("does not route custom OpenAI-compatible Afora configs through Codex auth order", () => {
    const config = {
      models: {
        providers: {
          openai: {
            baseUrl: "https://proxy.example.test/v1",
            models: [],
          },
        },
      },
      auth: {
        order: {
          openai: ["openai:work", "openai:backup"],
        },
      },
    } satisfies AforaConfig;

    expect(
      listOpenAIAuthProfileProvidersForAgentRuntime({
        provider: "openai",
        harnessRuntime: "afora",
        config,
      }),
    ).toEqual(["openai"]);
    expect(
      resolveSelectedOpenAIRuntimeProvider({
        provider: "openai",
        harnessRuntime: "afora",
        config,
      }),
    ).toBe("openai");
  });

  it("validates Codex harness auth through the unified OpenAI provider contract", () => {
    expect(
      listOpenAIAuthProfileProvidersForAgentRuntime({
        provider: "openai",
        harnessRuntime: "codex",
      }),
    ).toEqual(["openai"]);
  });

  it("keeps OpenAI as the runtime provider when harness runtime is codex", () => {
    expect(
      resolveSelectedOpenAIRuntimeProvider({
        provider: "openai",
        harnessRuntime: "codex",
      }),
    ).toBe("openai");
  });

  it("does not route non-OpenAI providers when runtime is codex", () => {
    expect(
      resolveSelectedOpenAIRuntimeProvider({
        provider: "anthropic",
        harnessRuntime: "codex",
      }),
    ).toBe("anthropic");
  });
});
