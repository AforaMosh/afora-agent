/** Covers plugin memory provider runtime loading and registration contracts. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryAccessContextFacts } from "./memory-access-context.js";

const resolveRuntimePluginRegistryMock =
  vi.fn<typeof import("./loader.js").resolveRuntimePluginRegistry>();
const getLoadedRuntimePluginRegistryMock =
  vi.fn<typeof import("./active-runtime-registry.js").getLoadedRuntimePluginRegistry>();
const ensureStandaloneRuntimePluginRegistryLoadedMock = vi.hoisted(() =>
  vi.fn<
    typeof import("./runtime/standalone-runtime-registry-loader.js").ensureStandaloneRuntimePluginRegistryLoaded
  >(),
);
const applyPluginAutoEnableMock =
  vi.fn<typeof import("../config/plugin-auto-enable.js").applyPluginAutoEnable>();
const getMemoryRuntimeMock = vi.fn<typeof import("./memory-state.js").getMemoryRuntime>();
const emitMemoryAuthorizationShadowSurfaceInspectionMock =
  vi.fn<
    typeof import("./memory-authorization-shadow.js").emitMemoryAuthorizationShadowSurfaceInspection
  >();
const resolveAgentWorkspaceDirMock =
  vi.fn<typeof import("../agents/agent-scope.js").resolveAgentWorkspaceDir>();
const resolveDefaultAgentIdMock = vi.fn<
  typeof import("../agents/agent-scope.js").resolveDefaultAgentId
>(() => "default");

vi.mock("../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: applyPluginAutoEnableMock,
}));

vi.mock("../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir: resolveAgentWorkspaceDirMock,
  resolveDefaultAgentId: resolveDefaultAgentIdMock,
}));

vi.mock("./loader.js", () => ({
  resolveRuntimePluginRegistry: resolveRuntimePluginRegistryMock,
}));

vi.mock("./active-runtime-registry.js", () => ({
  getLoadedRuntimePluginRegistry: getLoadedRuntimePluginRegistryMock,
}));

vi.mock("./runtime/standalone-runtime-registry-loader.js", () => ({
  ensureStandaloneRuntimePluginRegistryLoaded: ensureStandaloneRuntimePluginRegistryLoadedMock,
}));

vi.mock("./memory-state.js", () => ({
  getMemoryRuntime: () => getMemoryRuntimeMock(),
}));

vi.mock("./memory-authorization-shadow.js", () => ({
  emitMemoryAuthorizationShadowSurfaceInspection:
    emitMemoryAuthorizationShadowSurfaceInspectionMock,
}));

let getActiveMemorySearchManager: typeof import("./memory-runtime.js").getActiveMemorySearchManager;
let resolveActiveMemoryBackendConfig: typeof import("./memory-runtime.js").resolveActiveMemoryBackendConfig;
let authorizeActiveMemoryAccess: typeof import("./memory-runtime.js").authorizeActiveMemoryAccess;
let closeActiveMemorySearchManager: typeof import("./memory-runtime.js").closeActiveMemorySearchManager;
let closeActiveMemorySearchManagers: typeof import("./memory-runtime.js").closeActiveMemorySearchManagers;

async function createTrustedReadContext() {
  const { createMemoryAccessContextFactory } = await import("./memory-access-context.js");
  const identity = {
    sessionId: "session-1",
    sessionIdentityRevision: "session-revision-1",
    subjectRevision: "subject-revision-1",
    subject: {
      version: 1 as const,
      kind: "user" as const,
      principalId: "principal-owner",
      creationEvidence: {
        kind: "gateway-profile" as const,
        revision: "creation-revision-1",
      },
    },
  };
  const create = createMemoryAccessContextFactory({
    readCurrentSessionIdentity: async () => identity,
    now: () => Date.parse("2026-07-29T12:00:00.000Z"),
  });
  return await create({
    contextId: "context-1",
    requestId: "request-1",
    runId: "run-1",
    agentId: "main",
    sessionKey: "agent:main:main",
    sessionId: identity.sessionId,
    sessionIdentityRevision: identity.sessionIdentityRevision,
    subjectRevision: identity.subjectRevision,
    subject: identity.subject,
    actor: {
      kind: "principal",
      actorKind: "human",
      principalId: "principal-owner",
      assurance: "gateway-profile",
      evidenceRevision: "actor-revision-1",
    },
    verifiedPrincipals: [
      {
        principalId: "principal-owner",
        assurance: "gateway-profile",
        evidenceRevision: "principal-revision-1",
      },
    ],
    delivery: {
      sinkKind: "private",
      audiences: [{ kind: "user", id: "principal-owner" }],
      egressCapabilityIds: ["reply.final"],
      egressRegistryRevision: "egress-revision-1",
      deliveryRevision: "delivery-revision-1",
    },
    collaboration: { kind: "not-applicable" },
    verifiedMemberships: [],
    operation: "read",
    hostFactsRevision: "host-facts-revision-1",
  } satisfies MemoryAccessContextFacts);
}

function createMemoryAutoEnableFixture() {
  const rawConfig = {
    plugins: {},
    channels: { memory: { enabled: true } },
  };
  const autoEnabledConfig = {
    ...rawConfig,
    plugins: {
      entries: {
        memory: { enabled: true },
      },
    },
  };
  return { rawConfig, autoEnabledConfig };
}

function createMemoryRuntimeFixture() {
  return {
    getMemorySearchManager: vi.fn(async () => ({ manager: null, error: "no index" })),
    resolveMemoryBackendConfig: vi.fn(() => ({ backend: "builtin" as const })),
    closeMemorySearchManager: vi.fn(async () => {}),
  };
}

function expectMemoryRuntimeLoaded(
  config: unknown,
  pluginIds: readonly string[] = ["memory-core"],
) {
  expect(getLoadedRuntimePluginRegistryMock).toHaveBeenCalledWith({
    requiredPluginIds: pluginIds,
  });
  expect(ensureStandaloneRuntimePluginRegistryLoadedMock).toHaveBeenCalledWith({
    requiredPluginIds: pluginIds,
    loadOptions: {
      config,
      onlyPluginIds: pluginIds,
      workspaceDir: "/resolved-workspace",
    },
  });
}

function expectMemoryAutoEnableApplied(rawConfig: unknown, autoEnabledConfig: unknown) {
  expect(applyPluginAutoEnableMock).not.toHaveBeenCalled();
  expectMemoryRuntimeLoaded(rawConfig);
  expect(rawConfig).not.toBe(autoEnabledConfig);
}

function setAutoEnabledMemoryRuntime() {
  const { rawConfig, autoEnabledConfig } = createMemoryAutoEnableFixture();
  const runtime = createMemoryRuntimeFixture();
  applyPluginAutoEnableMock.mockReturnValue({
    config: autoEnabledConfig,
    changes: [],
    autoEnabledReasons: {},
  });
  getMemoryRuntimeMock
    .mockReturnValueOnce(undefined)
    .mockReturnValueOnce(undefined)
    .mockReturnValue(runtime);
  return { rawConfig, autoEnabledConfig, runtime };
}

function expectNoMemoryRuntimeBootstrap() {
  expect(applyPluginAutoEnableMock).not.toHaveBeenCalled();
  expect(resolveRuntimePluginRegistryMock).not.toHaveBeenCalled();
  expect(getLoadedRuntimePluginRegistryMock).not.toHaveBeenCalled();
  expect(ensureStandaloneRuntimePluginRegistryLoadedMock).not.toHaveBeenCalled();
}

async function expectAutoEnabledMemoryRuntimeCase(params: {
  run: (rawConfig: unknown) => Promise<unknown>;
  expectedResult: unknown;
}) {
  const { rawConfig, autoEnabledConfig } = setAutoEnabledMemoryRuntime();
  const result = await params.run(rawConfig);

  if (params.expectedResult !== undefined) {
    expect(result).toEqual(params.expectedResult);
  }
  expectMemoryAutoEnableApplied(rawConfig, autoEnabledConfig);
}

async function expectCloseMemoryRuntimeCase(params: {
  config: unknown;
  setup: () => { closeAllMemorySearchManagers: ReturnType<typeof vi.fn> } | undefined;
}) {
  const runtime = params.setup();
  await closeActiveMemorySearchManagers(params.config as never);

  if (runtime) {
    expect(runtime.closeAllMemorySearchManagers).toHaveBeenCalledTimes(1);
  }
  expectNoMemoryRuntimeBootstrap();
}

describe("memory runtime auto-enable loading", () => {
  beforeEach(async () => {
    vi.resetModules();
    ({
      getActiveMemorySearchManager,
      resolveActiveMemoryBackendConfig,
      authorizeActiveMemoryAccess,
      closeActiveMemorySearchManager,
      closeActiveMemorySearchManagers,
    } = await import("./memory-runtime.js"));
    resolveRuntimePluginRegistryMock.mockReset();
    getLoadedRuntimePluginRegistryMock.mockReset();
    ensureStandaloneRuntimePluginRegistryLoadedMock.mockReset();
    applyPluginAutoEnableMock.mockReset();
    getMemoryRuntimeMock.mockReset();
    emitMemoryAuthorizationShadowSurfaceInspectionMock.mockReset();
    resolveAgentWorkspaceDirMock.mockReset();
    resolveDefaultAgentIdMock.mockClear();
    applyPluginAutoEnableMock.mockImplementation((params) => ({
      config: params.config ?? {},
      changes: [],
      autoEnabledReasons: {},
    }));
    resolveAgentWorkspaceDirMock.mockReturnValue("/resolved-workspace");
  });

  it.each([
    {
      name: "loads memory runtime from the auto-enabled config snapshot",
      run: async (rawConfig: unknown) =>
        getActiveMemorySearchManager({
          cfg: rawConfig as never,
          agentId: "main",
        }),
      expectedResult: undefined,
    },
    {
      name: "reuses the same auto-enabled load path for backend config resolution",
      run: async (rawConfig: unknown) =>
        resolveActiveMemoryBackendConfig({
          cfg: rawConfig as never,
          agentId: "main",
        }),
      expectedResult: { backend: "builtin" },
    },
  ] as const)("$name", async ({ run, expectedResult }) => {
    await expectAutoEnabledMemoryRuntimeCase({ run, expectedResult });
  });

  it("loads only the configured memory slot plugin", async () => {
    const rawConfig = {
      plugins: {
        slots: {
          memory: "memory-lancedb",
        },
      },
    };
    const runtime = createMemoryRuntimeFixture();
    applyPluginAutoEnableMock.mockReturnValue({
      config: rawConfig,
      changes: [],
      autoEnabledReasons: {},
    });
    getMemoryRuntimeMock
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce(undefined)
      .mockReturnValue(runtime);

    await getActiveMemorySearchManager({
      cfg: rawConfig as never,
      agentId: "main",
    });

    expectMemoryRuntimeLoaded(rawConfig, ["memory-lancedb"]);
  });

  it("does not fall back to broad plugin loading when the memory slot is disabled", async () => {
    const rawConfig = {
      plugins: {
        slots: {
          memory: "none",
        },
      },
    };
    applyPluginAutoEnableMock.mockReturnValue({
      config: rawConfig,
      changes: [],
      autoEnabledReasons: {},
    });
    getMemoryRuntimeMock.mockReturnValue(undefined);

    await expect(
      getActiveMemorySearchManager({
        cfg: rawConfig as never,
        agentId: "main",
      }),
    ).resolves.toEqual({ manager: null, error: "memory plugin unavailable" });

    expect(applyPluginAutoEnableMock).not.toHaveBeenCalled();
    expect(resolveRuntimePluginRegistryMock).not.toHaveBeenCalled();
    expect(getLoadedRuntimePluginRegistryMock).not.toHaveBeenCalled();
    expect(ensureStandaloneRuntimePluginRegistryLoadedMock).not.toHaveBeenCalled();
  });

  it("does not standalone-load the memory plugin when plugins are globally disabled", async () => {
    const rawConfig = {
      plugins: {
        enabled: false,
      },
    };
    getMemoryRuntimeMock.mockReturnValue(undefined);

    await expect(
      getActiveMemorySearchManager({
        cfg: rawConfig as never,
        agentId: "main",
      }),
    ).resolves.toEqual({ manager: null, error: "memory plugin unavailable" });

    expectNoMemoryRuntimeBootstrap();
  });

  it.each([
    {
      name: "denied",
      plugins: {
        deny: ["memory-core"],
        slots: {
          memory: "memory-core",
        },
      },
    },
    {
      name: "entry-disabled",
      plugins: {
        entries: {
          "memory-core": { enabled: false },
        },
        slots: {
          memory: "memory-core",
        },
      },
    },
  ] as const)("does not standalone-load a $name memory slot plugin", async ({ plugins }) => {
    getMemoryRuntimeMock.mockReturnValue(undefined);

    await expect(
      getActiveMemorySearchManager({
        cfg: { plugins } as never,
        agentId: "main",
      }),
    ).resolves.toEqual({ manager: null, error: "memory plugin unavailable" });

    expectNoMemoryRuntimeBootstrap();
  });

  it("does not standalone-load plugins when the memory runtime is already registered", () => {
    const rawConfig = {
      plugins: {
        slots: {
          memory: "memory-core",
        },
      },
    };
    const runtime = createMemoryRuntimeFixture();
    getLoadedRuntimePluginRegistryMock.mockReturnValue({} as never);
    getMemoryRuntimeMock.mockReturnValueOnce(undefined).mockReturnValue(runtime);

    resolveActiveMemoryBackendConfig({
      cfg: rawConfig as never,
      agentId: "main",
    });

    expect(getLoadedRuntimePluginRegistryMock).toHaveBeenCalled();
    expect(ensureStandaloneRuntimePluginRegistryLoadedMock).not.toHaveBeenCalled();
  });

  it("evaluates shadow admission without changing manager acquisition inputs or results", async () => {
    const runtime = createMemoryRuntimeFixture();
    const cfg = { plugins: {} };
    const params = { cfg: cfg as never, agentId: "main", purpose: "default" as const };
    getMemoryRuntimeMock.mockReturnValue(runtime);

    const result = await getActiveMemorySearchManager(params);

    expect(result).toEqual({ manager: null, error: "no index" });
    expect(runtime.getMemorySearchManager).toHaveBeenCalledOnce();
    expect(runtime.getMemorySearchManager).toHaveBeenCalledWith(params);
    expect(emitMemoryAuthorizationShadowSurfaceInspectionMock).toHaveBeenCalledOnce();
    expect(emitMemoryAuthorizationShadowSurfaceInspectionMock).toHaveBeenCalledWith(runtime);
  });

  it("fails closed for QMD authorization without acquiring the legacy manager", async () => {
    const getMemorySearchManager = vi.fn(async () => ({ manager: null, error: "legacy path" }));
    const runtime = {
      getMemorySearchManager,
      resolveMemoryBackendConfig: vi.fn(() => ({ backend: "qmd" as const })),
    };
    getMemoryRuntimeMock.mockReturnValue(runtime);

    await expect(
      authorizeActiveMemoryAccess({
        cfg: {} as never,
        context: await createTrustedReadContext(),
      }),
    ).resolves.toEqual({
      runtime: null,
      plan: null,
      error: "authorized memory backend unavailable",
    });
    expect(getMemorySearchManager).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "does not bootstrap the memory runtime just to close managers",
      config: {
        plugins: {},
        channels: { memory: { enabled: true } },
      },
      setup: () => {
        getMemoryRuntimeMock.mockReturnValue(undefined);
        return undefined;
      },
    },
    {
      name: "closes an already-registered memory runtime without reloading plugins",
      config: {},
      setup: () => {
        const runtime = {
          getMemorySearchManager: vi.fn(async () => ({ manager: null, error: "no index" })),
          resolveMemoryBackendConfig: vi.fn(() => ({ backend: "builtin" as const })),
          closeAllMemorySearchManagers: vi.fn(async () => {}),
        };
        getMemoryRuntimeMock.mockReturnValue(runtime);
        return runtime;
      },
    },
  ] as const)("$name", async ({ config, setup }) => {
    await expectCloseMemoryRuntimeCase({ config, setup });
  });

  it("delegates scoped cleanup to the loaded memory runtime without reloading plugins", async () => {
    const runtime = createMemoryRuntimeFixture();
    const cfg = { plugins: {} };
    getMemoryRuntimeMock.mockReturnValue(runtime);

    await closeActiveMemorySearchManager({ cfg: cfg as never, agentId: "main" });

    expect(runtime.closeMemorySearchManager).toHaveBeenCalledWith({
      cfg,
      agentId: "main",
    });
    expectNoMemoryRuntimeBootstrap();
  });
});
