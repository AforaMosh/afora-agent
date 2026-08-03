// Verifies generated models.json preserves source secret markers from runtime snapshots.
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createFixtureSuite } from "../test-utils/fixture-suite.js";
import { NON_ENV_SECRETREF_MARKER } from "./model-auth-markers.js";
import {
  installModelsConfigTestHooks,
  MODELS_CONFIG_IMPLICIT_ENV_VARS,
  unsetEnv,
  withTempEnv,
} from "./models-config.e2e-harness.js";
import { enforceSourceManagedProviderSecrets } from "./models-config.providers.source-managed.js";

vi.mock("../plugins/manifest-registry.js", () => ({
  loadPluginManifestRegistry: () => ({ plugins: [] }),
}));

vi.mock("./model-auth-env-vars.js", () => ({
  listKnownProviderEnvApiKeyNames: () => ["OPENAI_API_KEY"],
  resolveProviderEnvAuthLookupMaps: () => ({
    aliasMap: {},
    envCandidateMap: { openai: ["OPENAI_API_KEY"] },
    authEvidenceMap: {},
  }),
}));

vi.mock("../plugins/provider-runtime.js", () => ({
  applyProviderConfigDefaultsWithPlugin: (config: OpenClawConfig) => config,
  applyProviderNativeStreamingUsageCompatWithPlugin: () => undefined,
  normalizeProviderConfigWithPlugin: () => undefined,
  resolveProviderConfigApiKeyWithPlugin: () => undefined,
  resolveProviderSyntheticAuthWithPlugin: () => undefined,
}));

vi.mock("./models-config.providers.js", async () => {
  const actual = await vi.importActual<typeof import("./models-config.providers.js")>(
    "./models-config.providers.js",
  );
  return {
    ...actual,
    resolveImplicitProviders: async () => ({}),
  };
});

installModelsConfigTestHooks();

let clearConfigCache: typeof import("../config/io.js").clearConfigCache;
let clearRuntimeConfigSnapshot: typeof import("../config/io.js").clearRuntimeConfigSnapshot;
let setRuntimeConfigSnapshot: typeof import("../config/io.js").setRuntimeConfigSnapshot;
let ensureOpenClawModelsJson: typeof import("./models-config.js").ensureOpenClawModelsJson;
let planOpenClawModelsJsonWithDeps: typeof import("./models-config.plan.test-support.js").planOpenClawModelsJsonWithDeps;
let readGeneratedModelsJson: typeof import("./models-config.test-utils.js").readGeneratedModelsJson;
const fixtureSuite = createFixtureSuite("openclaw-models-runtime-source-");

beforeAll(async () => {
  await fixtureSuite.setup();
  ({ clearConfigCache, clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } =
    await import("../config/io.js"));
  ({ ensureOpenClawModelsJson } = await import("./models-config.js"));
  ({ planOpenClawModelsJsonWithDeps } = await import("./models-config.plan.test-support.js"));
  ({ readGeneratedModelsJson } = await import("./models-config.test-utils.js"));
});

afterAll(async () => {
  await fixtureSuite.cleanup();
});

type ProviderConfig = NonNullable<NonNullable<OpenClawConfig["models"]>["providers"]>[string];
type GeneratedProvider = {
  baseUrl?: string;
  apiKey?: string;
  headers?: Record<string, string>;
};

const OPENAI_API_KEY_REF = {
  source: "env" as const,
  provider: "default",
  id: "OPENAI_API_KEY", // pragma: allowlist secret
};
const OPENAI_SOURCE_HEADERS = {
  Authorization: {
    source: "env" as const,
    provider: "default",
    id: "OPENAI_HEADER_TOKEN", // pragma: allowlist secret
  },
  "X-Tenant-Token": {
    source: "file" as const,
    provider: "vault",
    id: "/providers/openai/tenantToken",
  },
};
const OPENAI_RUNTIME_HEADERS = {
  Authorization: "Bearer runtime-openai-token",
  "X-Tenant-Token": "runtime-tenant-token",
};
const GATEWAY_TOKEN_CONFIG = { gateway: { auth: { mode: "token" as const } } };

function createProviderConfig(
  providerId: string,
  overrides: Partial<ProviderConfig>,
): OpenClawConfig {
  return {
    models: {
      providers: {
        [providerId]: {
          baseUrl: "https://api.openai.com/v1",
          api: "openai-completions" as const,
          models: [],
          ...overrides,
        },
      },
    },
  };
}

function createOpenAiApiKeySourceConfig(): OpenClawConfig {
  return createProviderConfig("openai", { apiKey: OPENAI_API_KEY_REF });
}

function createOpenAiApiKeyRuntimeConfig(): OpenClawConfig {
  // Runtime config simulates already-resolved secrets that must not be persisted.
  return createProviderConfig("openai", { apiKey: "sk-runtime-resolved" }); // pragma: allowlist secret
}

function getOpenAiProvider(config: OpenClawConfig) {
  return expectDefined(config.models?.providers?.openai, "OpenAI provider config");
}

async function expectGeneratedProviderApiKey(
  agentDir: string,
  providerId: string,
  expected: string,
) {
  const parsed = await readGeneratedModelsJson<{ providers: Record<string, GeneratedProvider> }>(
    agentDir,
  );
  expect(parsed.providers[providerId]?.apiKey).toBe(expected);
}

async function withSnapshotBackedGeneration(
  params: {
    sourceConfig: OpenClawConfig;
    runtimeConfig: OpenClawConfig;
    config?: OpenClawConfig;
  },
  verify: (agentDir: string) => Promise<void>,
) {
  const agentDir = await fixtureSuite.createCaseDir("agent");
  await withTempEnv(MODELS_CONFIG_IMPLICIT_ENV_VARS, async () => {
    unsetEnv(MODELS_CONFIG_IMPLICIT_ENV_VARS);
    try {
      setRuntimeConfigSnapshot(params.runtimeConfig, params.sourceConfig);
      await ensureOpenClawModelsJson(params.config ?? params.runtimeConfig, agentDir);
      await verify(agentDir);
    } finally {
      clearRuntimeConfigSnapshot();
      clearConfigCache();
    }
  });
}

async function planGeneratedProviders(params: {
  config: OpenClawConfig;
  sourceConfigForSecrets: OpenClawConfig;
}) {
  // Planner assertions avoid filesystem noise for marker-projection cases.
  const plan = await planOpenClawModelsJsonWithDeps(
    {
      cfg: params.config,
      sourceConfigForSecrets: params.sourceConfigForSecrets,
      agentDir: "/tmp/openclaw-models-plan",
      env: {},
      existingRaw: "",
      existingParsed: null,
    },
    {
      resolveImplicitProviders: async () => ({}),
    },
  );
  expect(plan.action).toBe("write");
  if (plan.action !== "write") {
    throw new Error(`expected models.json write plan, got ${plan.action}`);
  }
  return JSON.parse(plan.contents).providers as Record<string, GeneratedProvider>;
}

function expectOpenAiHeaderMarkers(
  providers: Record<string, { headers?: Record<string, string> }>,
) {
  // Env header refs keep their id; non-env refs collapse to the shared sentinel.
  expect(providers.openai?.headers?.Authorization).toBe(
    "secretref-env:OPENAI_HEADER_TOKEN", // pragma: allowlist secret
  );
  expect(providers.openai?.headers?.["X-Tenant-Token"]).toBe(NON_ENV_SECRETREF_MARKER);
}

describe("models-config runtime source snapshot", () => {
  it("uses runtime source snapshot markers when passed the active runtime config", () => {
    const sourceConfig: OpenClawConfig = {
      models: {
        providers: {
          openai: getOpenAiProvider(createOpenAiApiKeySourceConfig()),
          moonshot: {
            baseUrl: "https://api.moonshot.ai/v1",
            apiKey: { source: "file", provider: "vault", id: "/moonshot/apiKey" },
            api: "openai-completions" as const,
            models: [],
          },
        },
      },
    };
    const runtimeConfig: OpenClawConfig = {
      models: {
        providers: {
          openai: getOpenAiProvider(createOpenAiApiKeyRuntimeConfig()),
          moonshot: {
            baseUrl: "https://api.moonshot.ai/v1",
            apiKey: "sk-runtime-moonshot", // pragma: allowlist secret
            api: "openai-completions" as const,
            models: [],
          },
        },
      },
    };
    const providers = enforceSourceManagedProviderSecrets({
      providers: runtimeConfig.models!.providers!,
      sourceProviders: sourceConfig.models!.providers,
    })!;
    expect(providers.openai?.apiKey).toBe("OPENAI_API_KEY"); // pragma: allowlist secret
    expect(providers.moonshot?.apiKey).toBe(NON_ENV_SECRETREF_MARKER);
  });

  it("projects cloned runtime configs onto source snapshot when preserving provider auth", async () => {
    const sourceConfig = createOpenAiApiKeySourceConfig();
    const runtimeConfig = createOpenAiApiKeyRuntimeConfig();
    const clonedRuntimeConfig: OpenClawConfig = {
      ...runtimeConfig,
      agents: {
        defaults: {
          imageModel: "openai/gpt-image-1",
        },
      },
    };
    await withSnapshotBackedGeneration(
      { sourceConfig, runtimeConfig, config: clonedRuntimeConfig },
      async (agentDir) => {
        await expectGeneratedProviderApiKey(agentDir, "openai", "OPENAI_API_KEY"); // pragma: allowlist secret
      },
    );
  });

  it("preserves source markers for custom-provider api keys after models status secret resolution", async () => {
    await withSnapshotBackedGeneration(
      {
        sourceConfig: createProviderConfig("litellm", {
          baseUrl: "https://litellm.example/v1",
          apiKey: {
            source: "env",
            provider: "default",
            id: "OPENCLAW_MODEL_LITELLM_API_KEY", // pragma: allowlist secret
          },
        }),
        runtimeConfig: createProviderConfig("litellm", {
          baseUrl: "https://litellm.example/v1",
          apiKey: "sk-litellm-runtime-secret", // pragma: allowlist secret
        }),
      },
      async (agentDir) => {
        await expectGeneratedProviderApiKey(agentDir, "litellm", "OPENCLAW_MODEL_LITELLM_API_KEY"); // pragma: allowlist secret
      },
    );
  });

  it("invalidates cached readiness when projected config changes under the same runtime snapshot", async () => {
    const sourceConfig = createOpenAiApiKeySourceConfig();
    const runtimeConfig = createOpenAiApiKeyRuntimeConfig();
    const firstCandidate = createProviderConfig("openai", {
      apiKey: "sk-runtime-resolved", // pragma: allowlist secret
      headers: {
        "X-OpenClaw-Test": "one",
      },
    });
    const secondCandidate = createProviderConfig("openai", {
      baseUrl: "https://mirror.example/v1",
      apiKey: "sk-runtime-resolved", // pragma: allowlist secret
      headers: {
        "X-OpenClaw-Test": "two",
      },
    });
    await withSnapshotBackedGeneration(
      { sourceConfig, runtimeConfig, config: firstCandidate },
      async (agentDir) => {
        let parsed = await readGeneratedModelsJson<{
          providers: Record<string, GeneratedProvider>;
        }>(agentDir);
        expect(parsed.providers.openai?.baseUrl).toBe("https://api.openai.com/v1");
        expect(parsed.providers.openai?.apiKey).toBe("OPENAI_API_KEY"); // pragma: allowlist secret
        expect(parsed.providers.openai?.headers?.["X-OpenClaw-Test"]).toBe("one");

        // Header changes still rewrite models.json, but merge mode preserves the existing baseUrl.
        await ensureOpenClawModelsJson(secondCandidate, agentDir);
        parsed = await readGeneratedModelsJson<{
          providers: Record<string, GeneratedProvider>;
        }>(agentDir);
        expect(parsed.providers.openai?.baseUrl).toBe("https://api.openai.com/v1");
        expect(parsed.providers.openai?.apiKey).toBe("OPENAI_API_KEY"); // pragma: allowlist secret
        expect(parsed.providers.openai?.headers?.["X-OpenClaw-Test"]).toBe("two");
      },
    );
  });

  it("uses header markers from runtime source snapshot instead of resolved runtime values", async () => {
    const providers = await planGeneratedProviders({
      config: createProviderConfig("openai", { headers: OPENAI_RUNTIME_HEADERS }),
      sourceConfigForSecrets: createProviderConfig("openai", { headers: OPENAI_SOURCE_HEADERS }),
    });
    expectOpenAiHeaderMarkers(providers);
  });

  it("keeps source markers when runtime projection is skipped for incompatible top-level shape", async () => {
    const sourceConfig = {
      ...createProviderConfig("openai", {
        apiKey: OPENAI_API_KEY_REF,
        headers: OPENAI_SOURCE_HEADERS,
      }),
      ...GATEWAY_TOKEN_CONFIG,
    };
    const runtimeConfig = {
      ...createProviderConfig("openai", {
        apiKey: "sk-runtime-resolved", // pragma: allowlist secret
        headers: OPENAI_RUNTIME_HEADERS,
      }),
      ...GATEWAY_TOKEN_CONFIG,
    };
    await withSnapshotBackedGeneration(
      {
        sourceConfig,
        runtimeConfig,
        // Omitting the active runtime's gateway key forces projection to be skipped.
        config: createProviderConfig("openai", {
          apiKey: "sk-runtime-resolved", // pragma: allowlist secret
          headers: OPENAI_RUNTIME_HEADERS,
        }),
      },
      async (agentDir) => {
        const { providers } = await readGeneratedModelsJson<{
          providers: Record<string, GeneratedProvider>;
        }>(agentDir);
        expect(providers.openai?.apiKey).toBe("OPENAI_API_KEY"); // pragma: allowlist secret
        expectOpenAiHeaderMarkers(providers);
      },
    );
  });

  it("reapplies source markers when sourceConfigForSecrets uses mixed-case provider keys", async () => {
    // Regression: provider keys in sourceConfigForSecrets may arrive as "OpenAI" while the
    // merge boundary canonicalizes to "openai". The source-managed marker lookup must use the
    // same provider-id normalizer, otherwise the resolved runtime apiKey leaks into models.json.
    const providers = await planGeneratedProviders({
      config: createOpenAiApiKeyRuntimeConfig(),
      sourceConfigForSecrets: createProviderConfig("OpenAI", { apiKey: OPENAI_API_KEY_REF }),
    });
    expect(Object.keys(providers).toSorted()).toEqual(["openai"]);
    expect(providers.OpenAI).toBeUndefined();
    expect(providers.openai?.apiKey).toBe("OPENAI_API_KEY"); // pragma: allowlist secret
  });

  it("reapplies source header markers when sourceConfigForSecrets uses mixed-case provider keys", async () => {
    const providers = await planGeneratedProviders({
      config: createProviderConfig("openai", {
        apiKey: "sk-runtime-resolved", // pragma: allowlist secret
        headers: OPENAI_RUNTIME_HEADERS,
      }),
      sourceConfigForSecrets: createProviderConfig(" OpenAI ", {
        apiKey: OPENAI_API_KEY_REF,
        headers: OPENAI_SOURCE_HEADERS,
      }),
    });
    expect(Object.keys(providers).toSorted()).toEqual(["openai"]);
    expect(providers.OpenAI).toBeUndefined();
    expect(providers.openai?.apiKey).toBe("OPENAI_API_KEY"); // pragma: allowlist secret
    expectOpenAiHeaderMarkers(providers);
  });

  it.each([
    ["before", true],
    ["after", false],
  ])(
    "prefers canonical source secret ownership when it appears %s a case variant",
    async (_position, first) => {
      const canonical = getOpenAiProvider(createOpenAiApiKeySourceConfig());
      const caseVariant = {
        ...canonical,
        apiKey: {
          source: "env" as const,
          provider: "default",
          id: "OPENAI_CASE_VARIANT",
        },
      };
      const sourceProviders = first
        ? { openai: canonical, OpenAI: caseVariant }
        : { OpenAI: caseVariant, openai: canonical };
      const providers = await planGeneratedProviders({
        config: createOpenAiApiKeyRuntimeConfig(),
        sourceConfigForSecrets: { models: { providers: sourceProviders } },
      });

      expect(Object.keys(providers)).toEqual(["openai"]);
      expect(providers.openai?.apiKey).toBe("OPENAI_API_KEY"); // pragma: allowlist secret
    },
  );

  it("uses a valid case alias when the canonical source entry is not a provider record", () => {
    const runtimeConfig = createOpenAiApiKeyRuntimeConfig();
    const sourceProviders = {
      openai: null,
      OpenAI: getOpenAiProvider(createOpenAiApiKeySourceConfig()),
    } as unknown as NonNullable<NonNullable<OpenClawConfig["models"]>["providers"]>;

    const providers = enforceSourceManagedProviderSecrets({
      providers: runtimeConfig.models!.providers!,
      sourceProviders,
    });

    expect(providers?.openai?.apiKey).toBe("OPENAI_API_KEY"); // pragma: allowlist secret
  });
});
