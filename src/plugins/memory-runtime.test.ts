/** Covers non-activating memory registry handles and requesting-agent workspace ownership. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  MemorySearchManager,
  MemorySearchResult,
  MemorySource,
} from "../memory-host-sdk/host/types.js";
import type { MemoryAccessContextFacts } from "./memory-access-context.js";
import type { MemoryPluginRuntime } from "./registry-contribution-types.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { getPluginRuntimeGatewayRequestScope } from "./runtime/gateway-request-scope.js";

type AuthorizeSearchHits = NonNullable<MemoryPluginRuntime["authorizeSearchHits"]>;

const mocks = vi.hoisted(() => ({
  emitMemoryAuthorizationShadowSurfaceInspection: vi.fn(),
  getMemoryRuntime: vi.fn(),
  loadPluginRegistryHandle: vi.fn(),
  resolvePluginRegistryLoadCacheKey: vi.fn((options: unknown) => JSON.stringify(options)),
  resolveAgentWorkspaceDir: vi.fn(),
  shadowResults: [] as unknown[],
}));

vi.mock("../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir: mocks.resolveAgentWorkspaceDir,
}));

vi.mock("./loader.js", () => ({
  loadPluginRegistryHandle: mocks.loadPluginRegistryHandle,
  resolvePluginRegistryLoadCacheKey: mocks.resolvePluginRegistryLoadCacheKey,
}));

vi.mock("./memory-authorization-shadow.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./memory-authorization-shadow.js")>();
  return {
    ...actual,
    emitMemoryAuthorizationShadowSurfaceInspection: (
      ...args: Parameters<typeof actual.emitMemoryAuthorizationShadowSurfaceInspection>
    ) => {
      const result = actual.emitMemoryAuthorizationShadowSurfaceInspection(...args);
      mocks.shadowResults.push(result);
      mocks.emitMemoryAuthorizationShadowSurfaceInspection(...args);
      return result;
    },
  };
});

vi.mock("./memory-state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./memory-state.js")>();
  return { ...actual, getMemoryRuntime: mocks.getMemoryRuntime };
});

import {
  authorizeActiveMemoryAccess,
  authorizeActiveMemorySearchHits,
  closeActiveMemorySearchManager,
  closeActiveMemorySearchManagers,
  getActiveMemorySearchManager,
  resolveActiveMemoryBackendConfig,
} from "./memory-runtime.js";
import { resetStandaloneMemoryRegistrySlot } from "./memory-runtime.test-support.js";
import { hasMemoryRuntime } from "./memory-state.js";

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

function createRuntime() {
  return {
    authorizeSearchHits: vi.fn<AuthorizeSearchHits>(async ({ hits }) => hits),
    getMemorySearchManager: vi.fn(async () => ({ manager: null, error: "no index" })),
    resolveMemoryBackendConfig: vi.fn(() => ({ backend: "builtin" as const })),
    closeMemorySearchManager: vi.fn(async () => {}),
    closeAllMemorySearchManagers: vi.fn(async () => {}),
  } satisfies MemoryPluginRuntime;
}

type TestRegistry<T extends MemoryPluginRuntime> = {
  registry: ReturnType<typeof createEmptyPluginRegistry>;
  runtime: T;
};

function createRegistry(): TestRegistry<ReturnType<typeof createRuntime>>;
function createRegistry<T extends MemoryPluginRuntime>(runtime: T): TestRegistry<T>;
function createRegistry(
  runtime: MemoryPluginRuntime = createRuntime(),
): TestRegistry<MemoryPluginRuntime> {
  const registry = createEmptyPluginRegistry();
  registry.memoryCapabilities.push({ pluginId: "memory-core", capability: { runtime } });
  return { registry, runtime };
}

const memoryConfig = {
  plugins: { slots: { memory: "memory-core" } },
} as never;

describe("memory runtime handles", () => {
  beforeEach(() => {
    resetStandaloneMemoryRegistrySlot();
    mocks.emitMemoryAuthorizationShadowSurfaceInspection.mockReset();
    mocks.getMemoryRuntime.mockReset().mockReturnValue(undefined);
    mocks.loadPluginRegistryHandle.mockReset();
    mocks.resolvePluginRegistryLoadCacheKey.mockClear();
    mocks.shadowResults.length = 0;
    mocks.resolveAgentWorkspaceDir
      .mockReset()
      .mockImplementation((_cfg, agentId: string) =>
        agentId === "research" ? "/workspace/research" : "/workspace/main",
      );
  });

  it("loads only the selected memory plugin into a non-activating handle", async () => {
    const { registry, runtime } = createRegistry();
    runtime.getMemorySearchManager.mockImplementationOnce(async () => {
      expect(getPluginRuntimeGatewayRequestScope()?.pluginRegistry).toBe(registry);
      return { manager: null, error: "no index" };
    });
    runtime.resolveMemoryBackendConfig.mockImplementationOnce(() => {
      expect(getPluginRuntimeGatewayRequestScope()?.pluginRegistry).toBe(registry);
      return { backend: "builtin" };
    });
    mocks.loadPluginRegistryHandle.mockReturnValue(registry);

    await expect(
      getActiveMemorySearchManager({ cfg: memoryConfig, agentId: "main" }),
    ).resolves.toEqual({ manager: null, error: "no index" });

    expect(mocks.loadPluginRegistryHandle).toHaveBeenCalledWith({
      activate: false,
      config: memoryConfig,
      onlyPluginIds: ["memory-core"],
      workspaceDir: "/workspace/main",
    });
    expect(runtime.getMemorySearchManager).toHaveBeenCalledWith({
      cfg: memoryConfig,
      agentId: "main",
    });
    expect(resolveActiveMemoryBackendConfig({ cfg: memoryConfig, agentId: "main" })).toEqual({
      backend: "builtin",
    });
  });

  it("inspects a standalone runtime's authorization surface before use", async () => {
    const { registry, runtime } = createRegistry();
    mocks.loadPluginRegistryHandle.mockReturnValue(registry);

    await getActiveMemorySearchManager({ cfg: memoryConfig, agentId: "main" });

    expect(mocks.emitMemoryAuthorizationShadowSurfaceInspection).toHaveBeenCalledOnce();
    expect(mocks.emitMemoryAuthorizationShadowSurfaceInspection).toHaveBeenCalledWith(runtime);
  });

  it("preserves direct manager results across default, status, and CLI bridge acquisition", async () => {
    const allHits: MemorySearchResult[] = [
      {
        source: "memory",
        path: "MEMORY.md",
        startLine: 1,
        endLine: 1,
        score: 1,
        snippet: "personal memory",
      },
      {
        source: "sessions",
        path: "sessions/2026-07-29.jsonl",
        startLine: 1,
        endLine: 1,
        score: 0.9,
        snippet: "session memory",
      },
    ];
    const manager = {
      search: vi.fn(async (_query: string, options?: { sources?: MemorySource[] }) => {
        const sources = options?.sources ?? ["memory", "sessions"];
        return allHits.filter((hit) => sources.includes(hit.source));
      }),
      readFile: vi.fn(async () => ({ text: "", path: "MEMORY.md" })),
      status: vi.fn(() => ({ backend: "builtin" as const, provider: "fixture" })),
      probeEmbeddingAvailability: vi.fn(async () => ({ ok: true })),
      probeVectorAvailability: vi.fn(async () => true),
    } satisfies MemorySearchManager;
    const runtime = {
      ...createRuntime(),
      getMemorySearchManager: vi.fn(
        async (_params: Parameters<MemoryPluginRuntime["getMemorySearchManager"]>[0]) => ({
          manager,
        }),
      ),
    } satisfies MemoryPluginRuntime;
    const { registry } = createRegistry(runtime);
    mocks.loadPluginRegistryHandle.mockReturnValue(registry);
    const acquisitions = [
      { cfg: memoryConfig, agentId: "main", purpose: "default" },
      { cfg: memoryConfig, agentId: "main", purpose: "status" },
      { cfg: memoryConfig, agentId: "main", purpose: "cli" },
    ] as const;
    const sourceSets: readonly (readonly MemorySource[])[] = [
      ["memory"],
      ["sessions"],
      ["memory", "sessions"],
    ];

    for (const params of acquisitions) {
      const direct = await runtime.getMemorySearchManager(params);
      const bridged = await getActiveMemorySearchManager(params);

      expect(bridged).toEqual(direct);
      expect(bridged.manager).toBe(direct.manager);
      for (const sources of sourceSets) {
        const directHits = await direct.manager.search("same query", { sources: [...sources] });
        const bridgedHits = await bridged.manager?.search("same query", { sources: [...sources] });

        expect(bridgedHits).toEqual(directHits);
        expect(bridgedHits).toEqual(allHits.filter((hit) => sources.includes(hit.source)));
      }
    }

    expect(runtime.getMemorySearchManager).toHaveBeenCalledTimes(acquisitions.length * 2);
    expect(runtime.getMemorySearchManager.mock.calls).toEqual(
      acquisitions.flatMap((params) => [[params], [params]]),
    );
    expect(mocks.emitMemoryAuthorizationShadowSurfaceInspection).toHaveBeenCalledTimes(
      acquisitions.length,
    );
    expect(mocks.shadowResults.filter((result) => result !== undefined)).toHaveLength(1);
  });

  it("tracks standalone managers without activating config-only lookups and rearms reused handles", async () => {
    const { registry, runtime } = createRegistry();
    mocks.loadPluginRegistryHandle.mockReturnValue(registry);

    expect(hasMemoryRuntime()).toBe(false);
    expect(resolveActiveMemoryBackendConfig({ cfg: memoryConfig, agentId: "main" })).toEqual({
      backend: "builtin",
    });
    expect(hasMemoryRuntime()).toBe(false);

    await getActiveMemorySearchManager({ cfg: memoryConfig, agentId: "main" });
    expect(hasMemoryRuntime()).toBe(true);

    await closeActiveMemorySearchManagers();
    expect(hasMemoryRuntime()).toBe(false);

    await getActiveMemorySearchManager({ cfg: memoryConfig, agentId: "main" });
    expect(hasMemoryRuntime()).toBe(true);
    expect(mocks.loadPluginRegistryHandle).toHaveBeenCalledTimes(1);

    await closeActiveMemorySearchManagers();
    expect(runtime.closeAllMemorySearchManagers).toHaveBeenCalledTimes(2);
    expect(hasMemoryRuntime()).toBe(false);
  });

  it("retains standalone ownership across workspace replacement and per-agent cleanup", async () => {
    const main = createRegistry();
    const research = createRegistry();
    mocks.loadPluginRegistryHandle
      .mockReturnValueOnce(main.registry)
      .mockReturnValueOnce(research.registry);

    await getActiveMemorySearchManager({ cfg: memoryConfig, agentId: "main" });
    await getActiveMemorySearchManager({ cfg: memoryConfig, agentId: "research" });
    expect(hasMemoryRuntime()).toBe(true);

    await closeActiveMemorySearchManager({ cfg: memoryConfig, agentId: "main" });
    expect(hasMemoryRuntime()).toBe(true);

    await closeActiveMemorySearchManagers();
    expect(main.runtime.closeAllMemorySearchManagers).toHaveBeenCalledTimes(1);
    expect(research.runtime.closeAllMemorySearchManagers).toHaveBeenCalledTimes(1);
    expect(hasMemoryRuntime()).toBe(false);
  });

  it("retains standalone cleanup ownership when manager acquisition or teardown fails", async () => {
    const { registry, runtime } = createRegistry();
    mocks.loadPluginRegistryHandle.mockReturnValue(registry);
    runtime.getMemorySearchManager.mockRejectedValueOnce(
      new Error("manager initialization failed"),
    );

    await expect(
      getActiveMemorySearchManager({ cfg: memoryConfig, agentId: "main" }),
    ).rejects.toThrow("manager initialization failed");
    expect(hasMemoryRuntime()).toBe(true);

    runtime.closeAllMemorySearchManagers.mockRejectedValueOnce(
      new Error("manager teardown failed"),
    );
    await expect(closeActiveMemorySearchManagers()).rejects.toThrow("manager teardown failed");
    expect(hasMemoryRuntime()).toBe(true);

    await closeActiveMemorySearchManagers();
    expect(hasMemoryRuntime()).toBe(false);
  });

  it("keys the single slot by the requesting agent workspace", () => {
    const main = createRegistry();
    const research = createRegistry();
    mocks.loadPluginRegistryHandle
      .mockReturnValueOnce(main.registry)
      .mockReturnValueOnce(research.registry);

    expect(resolveActiveMemoryBackendConfig({ cfg: memoryConfig, agentId: "main" })).toEqual({
      backend: "builtin",
    });
    expect(resolveActiveMemoryBackendConfig({ cfg: memoryConfig, agentId: "main" })).toEqual({
      backend: "builtin",
    });
    expect(resolveActiveMemoryBackendConfig({ cfg: memoryConfig, agentId: "research" })).toEqual({
      backend: "builtin",
    });

    expect(mocks.resolveAgentWorkspaceDir).toHaveBeenNthCalledWith(1, memoryConfig, "main");
    expect(mocks.resolveAgentWorkspaceDir).toHaveBeenLastCalledWith(memoryConfig, "research");
    expect(mocks.loadPluginRegistryHandle).toHaveBeenCalledTimes(2);
  });

  it.each([
    { plugins: { enabled: false } },
    { plugins: { slots: { memory: "none" } } },
    { plugins: { slots: { memory: "memory-core" }, deny: ["memory-core"] } },
    {
      plugins: {
        slots: { memory: "memory-core" },
        entries: { "memory-core": { enabled: false } },
      },
    },
  ])("does not load a disabled memory selection", async (cfg) => {
    await expect(
      getActiveMemorySearchManager({ cfg: cfg as never, agentId: "main" }),
    ).resolves.toEqual({ manager: null, error: "memory plugin unavailable" });
    expect(mocks.loadPluginRegistryHandle).not.toHaveBeenCalled();
  });

  it("prefers an already-registered runtime", () => {
    const runtime = createRuntime();
    mocks.getMemoryRuntime.mockReturnValue(runtime);

    expect(resolveActiveMemoryBackendConfig({ cfg: memoryConfig, agentId: "main" })).toEqual({
      backend: "builtin",
    });
    expect(mocks.loadPluginRegistryHandle).not.toHaveBeenCalled();
    expect(mocks.emitMemoryAuthorizationShadowSurfaceInspection).toHaveBeenCalledOnce();
    expect(mocks.emitMemoryAuthorizationShadowSurfaceInspection).toHaveBeenCalledWith(runtime);
  });

  it("fails closed for QMD authorization without acquiring the legacy manager", async () => {
    const getMemorySearchManager = vi.fn(async () => ({ manager: null, error: "legacy path" }));
    const runtime = {
      getMemorySearchManager,
      resolveMemoryBackendConfig: vi.fn(() => ({ backend: "qmd" as const })),
    } satisfies MemoryPluginRuntime;
    mocks.getMemoryRuntime.mockReturnValue(runtime);

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

  it("authorizes raw hits inside the selected plugin runtime scope", async () => {
    const { registry, runtime } = createRegistry();
    runtime.authorizeSearchHits.mockImplementationOnce(async ({ hits }) => {
      expect(getPluginRuntimeGatewayRequestScope()?.pluginRegistry).toBe(registry);
      return hits.filter((hit) => hit.source === "memory");
    });
    mocks.loadPluginRegistryHandle.mockReturnValue(registry);
    const hits: MemorySearchResult[] = [
      {
        source: "memory",
        path: "memory.md",
        startLine: 1,
        endLine: 1,
        score: 1,
        snippet: "memory",
      },
      {
        source: "sessions",
        path: "sessions/private.jsonl",
        startLine: 1,
        endLine: 1,
        score: 1,
        snippet: "private",
      },
    ];

    await expect(
      authorizeActiveMemorySearchHits({
        cfg: memoryConfig,
        agentId: "main",
        requesterSessionKey: "agent:main:voice:15550001234",
        sandboxed: false,
        hits,
      }),
    ).resolves.toEqual([hits[0]]);
  });

  it("fails closed on session hits when a memory runtime has no authorizer", async () => {
    const runtimeWithoutAuthorizer = {
      getMemorySearchManager: vi.fn(async () => ({ manager: null, error: "no index" })),
      resolveMemoryBackendConfig: vi.fn(() => ({ backend: "builtin" as const })),
      closeMemorySearchManager: vi.fn(async () => {}),
      closeAllMemorySearchManagers: vi.fn(async () => {}),
    } satisfies MemoryPluginRuntime;
    mocks.loadPluginRegistryHandle.mockReturnValue(
      createRegistry(runtimeWithoutAuthorizer).registry,
    );
    const hits: MemorySearchResult[] = [
      {
        source: "memory",
        path: "memory.md",
        startLine: 1,
        endLine: 1,
        score: 1,
        snippet: "memory",
      },
      {
        source: "sessions",
        path: "sessions/private.jsonl",
        startLine: 1,
        endLine: 1,
        score: 1,
        snippet: "private",
      },
    ];

    await expect(
      authorizeActiveMemorySearchHits({
        cfg: memoryConfig,
        agentId: "main",
        requesterSessionKey: "agent:main:voice:15550001234",
        sandboxed: false,
        hits,
      }),
    ).resolves.toEqual([hits[0]]);
  });

  it("closes managers through current and retired workspace handles without reloading", async () => {
    const main = createRegistry();
    const research = createRegistry();
    for (const owner of [main, research]) {
      owner.runtime.closeMemorySearchManager.mockImplementationOnce(async () => {
        expect(getPluginRuntimeGatewayRequestScope()?.pluginRegistry).toBe(owner.registry);
      });
      owner.runtime.closeAllMemorySearchManagers.mockImplementationOnce(async () => {
        expect(getPluginRuntimeGatewayRequestScope()?.pluginRegistry).toBe(owner.registry);
      });
    }
    mocks.loadPluginRegistryHandle
      .mockReturnValueOnce(main.registry)
      .mockReturnValueOnce(research.registry);
    resolveActiveMemoryBackendConfig({ cfg: memoryConfig, agentId: "main" });
    resolveActiveMemoryBackendConfig({ cfg: memoryConfig, agentId: "research" });
    mocks.loadPluginRegistryHandle.mockClear();

    await closeActiveMemorySearchManager({ cfg: memoryConfig, agentId: "main" });
    await closeActiveMemorySearchManagers(memoryConfig);

    for (const { runtime } of [main, research]) {
      expect(runtime.closeMemorySearchManager).toHaveBeenCalledWith({
        cfg: memoryConfig,
        agentId: "main",
      });
      expect(runtime.closeAllMemorySearchManagers).toHaveBeenCalledTimes(1);
    }
    expect(mocks.loadPluginRegistryHandle).not.toHaveBeenCalled();
  });
});
