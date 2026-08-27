// ACPX tests cover service plugin behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { createDeferred } from "afora-agent/plugin-sdk/extension-shared";
import { MAX_TIMER_TIMEOUT_MS } from "afora-agent/plugin-sdk/number-runtime";
import type { OpenKeyedStoreOptions } from "afora-agent/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "afora-agent/plugin-sdk/plugin-state-test-runtime";
import {
  resolvePreferredAforaTmpDir,
  tempWorkspace,
  type TempWorkspace,
} from "afora-agent/plugin-sdk/temp-path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { runtimeRegistry } = vi.hoisted(() => ({
  runtimeRegistry: new Map<string, { runtime: unknown; healthy?: () => boolean }>(),
}));
const { prepareAcpxCodexAuthConfigMock } = vi.hoisted(() => ({
  prepareAcpxCodexAuthConfigMock: vi.fn(
    async ({ pluginConfig }: { pluginConfig: unknown }) => pluginConfig,
  ),
}));
const { cleanupAforaOwnedAcpxProcessTreeMock } = vi.hoisted(() => ({
  cleanupAforaOwnedAcpxProcessTreeMock: vi.fn(
    async (): Promise<{
      inspectedPids: number[];
      terminatedPids: number[];
      skippedReason?: string;
    }> => ({
      inspectedPids: [],
      terminatedPids: [],
    }),
  ),
}));
const { cleanupAforaOwnedAcpxPendingLeaseMock } = vi.hoisted(() => ({
  cleanupAforaOwnedAcpxPendingLeaseMock: vi.fn(
    async (): Promise<{
      inspectedPids: number[];
      terminatedPids: number[];
      skippedReason?: string;
    }> => ({
      inspectedPids: [],
      terminatedPids: [],
      skippedReason: "missing-root",
    }),
  ),
}));
const { reapStaleAforaOwnedAcpxOrphansMock } = vi.hoisted(() => ({
  reapStaleAforaOwnedAcpxOrphansMock: vi.fn(
    async (): Promise<{
      inspectedPids: number[];
      terminatedPids: number[];
      skippedReason?: string;
    }> => ({
      inspectedPids: [],
      terminatedPids: [],
    }),
  ),
}));
const { acpxRuntimeConstructorMock, createAgentRegistryMock, createFileSessionStoreMock } =
  vi.hoisted(() => ({
    acpxRuntimeConstructorMock: vi.fn(function AcpxRuntime(options: unknown) {
      return {
        cancel: vi.fn(async () => {}),
        close: vi.fn(async () => {}),
        doctor: vi.fn(async () => ({ ok: true, message: "ok" })),
        ensureSession: vi.fn(async () => ({
          backend: "acpx",
          runtimeSessionName: "agent:codex:acp:test",
          sessionKey: "agent:codex:acp:test",
        })),
        getCapabilities: vi.fn(async () => ({ controls: [] })),
        getStatus: vi.fn(async () => ({ summary: "ready" })),
        isHealthy: vi.fn(() => true),
        prepareFreshSession: vi.fn(async () => {}),
        probeAvailability: vi.fn(async () => {}),
        runTurn: vi.fn(async function* () {}),
        setConfigOption: vi.fn(async () => {}),
        setMode: vi.fn(async () => {}),
        __options: options,
      };
    }),
    createAgentRegistryMock: vi.fn(() => ({})),
    createFileSessionStoreMock: vi.fn(() => ({})),
  }));

vi.mock("../runtime-api.js", () => ({
  getAcpRuntimeBackend: (id: string) => runtimeRegistry.get(id),
}));

vi.mock("./runtime.js", () => ({
  ACPX_BACKEND_ID: "acpx",
  AcpxRuntime: acpxRuntimeConstructorMock,
  createAgentRegistry: createAgentRegistryMock,
  createFileSessionStore: createFileSessionStoreMock,
}));

vi.mock("./codex-auth-bridge.js", () => ({
  prepareAcpxCodexAuthConfig: prepareAcpxCodexAuthConfigMock,
}));

vi.mock("./process-reaper.js", () => ({
  cleanupAforaOwnedAcpxPendingLease: cleanupAforaOwnedAcpxPendingLeaseMock,
  cleanupAforaOwnedAcpxProcessTree: cleanupAforaOwnedAcpxProcessTreeMock,
  reapStaleAforaOwnedAcpxOrphans: reapStaleAforaOwnedAcpxOrphansMock,
}));

import { getAcpRuntimeBackend } from "../runtime-api.js";
import type { AforaPluginServiceContext } from "../runtime-api.js";
import {
  ACPX_PROBE_LEASE_SESSION_KEY,
  openAcpxProcessLeaseStateStore,
  type AcpxProcessLease,
} from "./process-lease.js";
import {
  createAcpxRuntimeService as createRealAcpxRuntimeService,
  resolveAcpxTimerTimeoutMs,
} from "./service.js";
import {
  ACPX_GATEWAY_INSTANCE_KEY,
  ACPX_GATEWAY_INSTANCE_MAX_ENTRIES,
  ACPX_GATEWAY_INSTANCE_NAMESPACE,
  type AcpxGatewayInstanceRecord,
} from "./state.js";

let testWorkspace: TempWorkspace;
const previousEnv = {
  AFORA_ACPX_RUNTIME_STARTUP_PROBE: process.env.AFORA_ACPX_RUNTIME_STARTUP_PROBE,
  AFORA_SKIP_ACPX_RUNTIME: process.env.AFORA_SKIP_ACPX_RUNTIME,
  AFORA_SKIP_ACPX_RUNTIME_PROBE: process.env.AFORA_SKIP_ACPX_RUNTIME_PROBE,
};

function restoreEnv(name: keyof typeof previousEnv): void {
  const value = previousEnv[name];
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

beforeEach(async () => {
  testWorkspace = await tempWorkspace({
    rootDir: resolvePreferredAforaTmpDir(),
    prefix: "afora-acpx-service-",
  });
});

afterEach(async () => {
  resetPluginStateStoreForTests();
  runtimeRegistry.clear();
  prepareAcpxCodexAuthConfigMock.mockClear();
  cleanupAforaOwnedAcpxProcessTreeMock.mockClear();
  cleanupAforaOwnedAcpxPendingLeaseMock.mockClear();
  reapStaleAforaOwnedAcpxOrphansMock.mockClear();
  acpxRuntimeConstructorMock.mockClear();
  createAgentRegistryMock.mockClear();
  createFileSessionStoreMock.mockClear();
  restoreEnv("AFORA_ACPX_RUNTIME_STARTUP_PROBE");
  restoreEnv("AFORA_SKIP_ACPX_RUNTIME");
  restoreEnv("AFORA_SKIP_ACPX_RUNTIME_PROBE");
  await testWorkspace.cleanup();
});

function createServiceContext(workspaceDir: string): AforaPluginServiceContext {
  return {
    workspaceDir,
    stateDir: path.join(workspaceDir, ".afora-plugin-state"),
    config: {},
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  };
}

function createOpenKeyedStore(ctx: AforaPluginServiceContext) {
  const env = { ...process.env, AFORA_STATE_DIR: ctx.stateDir };
  return <T>(options: OpenKeyedStoreOptions) =>
    createPluginStateKeyedStoreForTests<T>("acpx", {
      ...options,
      env: options.env ?? env,
    });
}

function createAcpxRuntimeService(
  ctx: AforaPluginServiceContext,
  params: Omit<Parameters<typeof createRealAcpxRuntimeService>[0], "backendLifecycle"> & {
    backendLifecycle?: Parameters<typeof createRealAcpxRuntimeService>[0]["backendLifecycle"];
  } = {},
) {
  const backendLifecycle = params.backendLifecycle ?? {
    publish(backend: { runtime: unknown; healthy?: () => boolean }) {
      runtimeRegistry.set("acpx", backend);
    },
    retract(runtime: unknown) {
      if (runtimeRegistry.get("acpx")?.runtime === runtime) {
        runtimeRegistry.delete("acpx");
      }
    },
  };
  return createRealAcpxRuntimeService({
    ...params,
    backendLifecycle,
    openKeyedStore: params.openKeyedStore ?? createOpenKeyedStore(ctx),
  });
}

function openGatewayInstanceStore(ctx: AforaPluginServiceContext) {
  return createOpenKeyedStore(ctx)<AcpxGatewayInstanceRecord>({
    namespace: ACPX_GATEWAY_INSTANCE_NAMESPACE,
    maxEntries: ACPX_GATEWAY_INSTANCE_MAX_ENTRIES,
  });
}

function openProcessLeaseStore(ctx: AforaPluginServiceContext) {
  return openAcpxProcessLeaseStateStore(createOpenKeyedStore(ctx));
}

function createMockRuntime(overrides: Record<string, unknown> = {}) {
  return {
    ensureSession: vi.fn(),
    runTurn: vi.fn(),
    cancel: vi.fn(),
    close: vi.fn(),
    probeAvailability: vi.fn(async () => {}),
    isHealthy: vi.fn(() => true),
    doctor: vi.fn(async () => ({ ok: true, message: "ok" })),
    ...overrides,
  };
}

function createStartupTraceRecorder() {
  const measured: string[] = [];
  const details: Array<{
    name: string;
    metrics: ReadonlyArray<readonly [string, number | string]>;
  }> = [];
  return {
    measured,
    details,
    startupTrace: {
      measure: async <T>(name: string, run: () => T | Promise<T>): Promise<T> => {
        measured.push(name);
        return await run();
      },
      detail: (name: string, metrics: ReadonlyArray<readonly [string, number | string]>) => {
        details.push({ name, metrics });
      },
    },
  };
}

function readFirstRuntimeFactoryInput(runtimeFactory: { mock: { calls: Array<Array<unknown>> } }) {
  const [call] = runtimeFactory.mock.calls;
  if (!call) {
    throw new Error("Expected runtimeFactory to be called");
  }
  const [input] = call;
  if (typeof input !== "object" || input === null) {
    throw new Error("Expected runtimeFactory to be called with an options object");
  }
  return input as {
    pluginConfig: {
      timeoutSeconds?: number;
      probeAgent?: string;
    };
  };
}

describe("createAcpxRuntimeService", () => {
  it("caps configured timeout seconds to timer-safe milliseconds", () => {
    expect(resolveAcpxTimerTimeoutMs(0.001)).toBe(1);
    expect(resolveAcpxTimerTimeoutMs(Number.MAX_SAFE_INTEGER)).toBe(MAX_TIMER_TIMEOUT_MS);
  });

  it("registers and unregisters the embedded backend", async () => {
    const workspaceDir = testWorkspace.dir;
    const ctx = createServiceContext(workspaceDir);
    const runtime = createMockRuntime();
    const service = createAcpxRuntimeService(ctx, {
      runtimeFactory: () => runtime as never,
    });

    await service.start(ctx);

    expect(getAcpRuntimeBackend("acpx")?.runtime).toBe(runtime);

    await service.stop?.(ctx);

    expect(getAcpRuntimeBackend("acpx")).toBeUndefined();
  });

  it("publishes before probing and retracts the exact runtime through the injected lifecycle", async () => {
    delete process.env.AFORA_ACPX_RUNTIME_STARTUP_PROBE;
    const workspaceDir = testWorkspace.dir;
    const ctx = createServiceContext(workspaceDir);
    const probeStarted = createDeferred<void>();
    const releaseProbe = createDeferred<void>();
    const events: string[] = [];
    const runtime = createMockRuntime({
      probeAvailability: vi.fn(async () => {
        events.push("probe");
        probeStarted.resolve();
        await releaseProbe.promise;
      }),
    });
    const publish = vi.fn((backend: { runtime: unknown; healthy?: () => boolean }) => {
      events.push("publish");
      expect(backend.runtime).toBe(runtime);
      expect(backend.healthy?.()).toBe(true);
    });
    const retract = vi.fn((ownedRuntime: unknown) => {
      events.push("retract");
      expect(ownedRuntime).toBe(runtime);
    });
    const service = createAcpxRuntimeService(ctx, {
      backendLifecycle: { publish, retract },
      runtimeFactory: () => runtime as never,
    });

    const starting = service.start(ctx) as Promise<void>;
    await probeStarted.promise;

    expect(events).toEqual(["publish", "probe"]);
    expect(publish).toHaveBeenCalledOnce();
    expect(getAcpRuntimeBackend("acpx")).toBeUndefined();

    await service.stop?.(ctx);
    expect(retract).toHaveBeenCalledWith(runtime);
    expect(events).toEqual(["publish", "probe", "retract"]);

    releaseProbe.resolve();
    await starting;
  });

  it("skips the startup probe and does not advertise backend health when explicitly disabled", async () => {
    process.env.AFORA_ACPX_RUNTIME_STARTUP_PROBE = "0";
    delete process.env.AFORA_SKIP_ACPX_RUNTIME_PROBE;
    const workspaceDir = testWorkspace.dir;
    const stateDir = path.join(workspaceDir, "custom-state");
    const ctx = createServiceContext(workspaceDir);
    const probeAvailability = vi.fn(async () => {
      await fs.access(stateDir);
    });
    const runtime = createMockRuntime({
      doctor: async () => ({ ok: true, message: "ok" }),
      isHealthy: () => false,
      probeAvailability,
    });
    const service = createAcpxRuntimeService(ctx, {
      pluginConfig: { stateDir },
      runtimeFactory: () => runtime as never,
    });

    await service.start(ctx);

    await fs.access(stateDir);
    expect(probeAvailability).not.toHaveBeenCalled();
    expect(getAcpRuntimeBackend("acpx")?.healthy).toBeUndefined();

    await service.stop?.(ctx);
  });

  it("waits for the embedded runtime startup probe before resolving by default", async () => {
    delete process.env.AFORA_ACPX_RUNTIME_STARTUP_PROBE;
    const workspaceDir = testWorkspace.dir;
    const ctx = createServiceContext(workspaceDir);
    let releaseProbe!: () => void;
    const probeStarted = vi.fn();
    const probeAvailability = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          probeStarted();
          releaseProbe = resolve;
        }),
    );
    const runtime = createMockRuntime({
      probeAvailability,
      isHealthy: () => true,
    });
    const service = createAcpxRuntimeService(ctx, {
      runtimeFactory: () => runtime as never,
    });

    const startPromise = service.start(ctx) as Promise<void>;
    await vi.waitFor(() => {
      expect(probeStarted).toHaveBeenCalledOnce();
    });

    let resolved = false;
    void startPromise.then(() => {
      resolved = true;
    });
    await Promise.resolve();

    expect(resolved).toBe(false);
    releaseProbe();
    await startPromise;

    expect(resolved).toBe(true);
    expect(ctx.logger.info).toHaveBeenCalledWith("embedded acpx runtime backend ready");

    await service.stop?.(ctx);
  });

  it("emits ACPX-owned startup trace subspans", async () => {
    delete process.env.AFORA_ACPX_RUNTIME_STARTUP_PROBE;
    const workspaceDir = testWorkspace.dir;
    const ctx = createServiceContext(workspaceDir);
    const trace = createStartupTraceRecorder();
    ctx.startupTrace = trace.startupTrace;
    const runtime = createMockRuntime();
    const service = createAcpxRuntimeService(ctx, {
      runtimeFactory: () => runtime as never,
    });

    await service.start(ctx);

    expect(trace.measured).toEqual([
      "config.resolve",
      "config.prepare-codex-auth",
      "filesystem.prepare",
      "gateway-instance-id",
      "process-leases.reap",
      "runtime.create",
      "backend.register",
      "probe.availability",
    ]);
    expect(trace.details).toEqual([
      {
        name: "probe-policy",
        metrics: [
          ["startupProbeEnabledCount", 1],
          ["probeAgent", "default"],
        ],
      },
      {
        name: "probe.result",
        metrics: [["healthyCount", 1]],
      },
    ]);

    await service.stop?.(ctx);
  });

  it("reaps stale ACPX process leases from the generated wrapper root at startup", async () => {
    const workspaceDir = testWorkspace.dir;
    const ctx = createServiceContext(workspaceDir);
    const runtime = createMockRuntime();
    const processCleanupDeps = { sleep: vi.fn(async () => {}) };
    const wrapperRoot = path.join(ctx.stateDir, "acpx");
    await openGatewayInstanceStore(ctx).register(ACPX_GATEWAY_INSTANCE_KEY, {
      instanceId: "gw-test",
      createdAt: 1,
    });
    const lease: AcpxProcessLease = {
      leaseId: "lease-1",
      gatewayInstanceId: "gw-test",
      sessionKey: "agent:codex:acp:test",
      wrapperRoot,
      wrapperPath: path.join(wrapperRoot, "codex-acp-wrapper.mjs"),
      rootPid: 101,
      commandHash: "hash",
      startedAt: 1,
      state: "open",
    };
    await openProcessLeaseStore(ctx).register(lease.leaseId, lease);
    cleanupAforaOwnedAcpxProcessTreeMock.mockResolvedValueOnce({
      inspectedPids: [101, 102],
      terminatedPids: [101, 102],
    });
    const service = createAcpxRuntimeService(ctx, {
      runtimeFactory: () => runtime as never,
      processCleanupDeps,
    });

    await service.start(ctx);

    expect(cleanupAforaOwnedAcpxProcessTreeMock).toHaveBeenCalledWith({
      rootPid: 101,
      expectedLeaseId: "lease-1",
      expectedGatewayInstanceId: "gw-test",
      wrapperRoot,
      deps: processCleanupDeps,
    });
    expect(ctx.logger.info).toHaveBeenCalledWith("reaped 2 stale Afora-owned ACPX processes");

    await service.stop?.(ctx);
  });

  it("keeps PID-bearing leases when startup process listing is unavailable", async () => {
    const workspaceDir = testWorkspace.dir;
    const ctx = createServiceContext(workspaceDir);
    const runtime = createMockRuntime();
    const wrapperRoot = path.join(ctx.stateDir, "acpx");
    await openGatewayInstanceStore(ctx).register(ACPX_GATEWAY_INSTANCE_KEY, {
      instanceId: "gw-test",
      createdAt: 1,
    });
    const lease: AcpxProcessLease = {
      leaseId: "lease-process-list-unavailable",
      gatewayInstanceId: "gw-test",
      sessionKey: "agent:codex:acp:test",
      wrapperRoot,
      wrapperPath: path.join(wrapperRoot, "codex-acp-wrapper.mjs"),
      rootPid: 101,
      commandHash: "hash",
      startedAt: 1,
      state: "open",
    };
    await openProcessLeaseStore(ctx).register(lease.leaseId, lease);
    cleanupAforaOwnedAcpxProcessTreeMock.mockResolvedValueOnce({
      inspectedPids: [],
      terminatedPids: [],
      skippedReason: "process-list-unavailable",
    });
    const service = createAcpxRuntimeService(ctx, {
      runtimeFactory: () => runtime as never,
    });

    await service.start(ctx);

    await expect(openProcessLeaseStore(ctx).lookup(lease.leaseId)).resolves.toMatchObject({
      leaseId: lease.leaseId,
      rootPid: 101,
      state: "open",
    });
    await service.stop?.(ctx);
  });

  it("recovers a pending ACPX lease from exact wrapper identity before retiring it", async () => {
    const workspaceDir = testWorkspace.dir;
    const ctx = createServiceContext(workspaceDir);
    const runtime = createMockRuntime();
    const processCleanupDeps = { sleep: vi.fn(async () => {}) };
    const wrapperRoot = path.join(ctx.stateDir, "acpx");
    await fs.mkdir(wrapperRoot, { recursive: true });
    await openGatewayInstanceStore(ctx).register(ACPX_GATEWAY_INSTANCE_KEY, {
      instanceId: "gw-test",
      createdAt: 1,
    });
    const lease: AcpxProcessLease = {
      leaseId: "lease-pending",
      gatewayInstanceId: "gw-test",
      sessionKey: "agent:codex:acp:test",
      wrapperRoot,
      wrapperPath: path.join(wrapperRoot, "codex-acp-wrapper.mjs"),
      rootPid: 0,
      commandHash: "hash",
      startedAt: 1,
      state: "open",
    };
    await openProcessLeaseStore(ctx).register(lease.leaseId, lease);
    cleanupAforaOwnedAcpxPendingLeaseMock.mockResolvedValueOnce({
      inspectedPids: [201, 202],
      terminatedPids: [201, 202],
    });
    const service = createAcpxRuntimeService(ctx, {
      runtimeFactory: () => runtime as never,
      processCleanupDeps,
    });

    await service.start(ctx);

    expect(cleanupAforaOwnedAcpxPendingLeaseMock).toHaveBeenCalledWith({
      leaseId: "lease-pending",
      gatewayInstanceId: "gw-test",
      wrapperRoot,
      wrapperPath: path.join(wrapperRoot, "codex-acp-wrapper.mjs"),
      deps: processCleanupDeps,
    });
    expect(reapStaleAforaOwnedAcpxOrphansMock).toHaveBeenCalledWith({
      wrapperRoot,
      deps: processCleanupDeps,
    });
    expect(ctx.logger.info).toHaveBeenCalledWith("reaped 2 stale Afora-owned ACPX processes");
    await expect(openProcessLeaseStore(ctx).lookup("lease-pending")).resolves.toBeUndefined();

    await service.stop?.(ctx);
  });

  it("keeps pending leases open when exact process evidence is ambiguous", async () => {
    const workspaceDir = testWorkspace.dir;
    const ctx = createServiceContext(workspaceDir);
    const runtime = createMockRuntime();
    const wrapperRoot = path.join(ctx.stateDir, "acpx");
    await openGatewayInstanceStore(ctx).register(ACPX_GATEWAY_INSTANCE_KEY, {
      instanceId: "gw-test",
      createdAt: 1,
    });
    const lease: AcpxProcessLease = {
      leaseId: "lease-ambiguous",
      gatewayInstanceId: "gw-test",
      sessionKey: "agent:codex:acp:test",
      wrapperRoot,
      wrapperPath: path.join(wrapperRoot, "codex-acp-wrapper.mjs"),
      rootPid: 0,
      commandHash: "hash",
      startedAt: 1,
      state: "open",
    };
    await openProcessLeaseStore(ctx).register(lease.leaseId, lease);
    cleanupAforaOwnedAcpxPendingLeaseMock.mockResolvedValueOnce({
      inspectedPids: [201, 202],
      terminatedPids: [],
      skippedReason: "ambiguous-root",
    });
    reapStaleAforaOwnedAcpxOrphansMock.mockResolvedValueOnce({
      inspectedPids: [301],
      terminatedPids: [301],
    });
    const service = createAcpxRuntimeService(ctx, {
      runtimeFactory: () => runtime as never,
    });

    await service.start(ctx);

    await expect(openProcessLeaseStore(ctx).lookup(lease.leaseId)).resolves.toMatchObject({
      leaseId: lease.leaseId,
      rootPid: 0,
      state: "open",
    });
    await service.stop?.(ctx);
  });

  it("keeps an absent pending probe lease open for unidentifiable descendants", async () => {
    const workspaceDir = testWorkspace.dir;
    const ctx = createServiceContext(workspaceDir);
    const runtime = createMockRuntime();
    const wrapperRoot = path.join(ctx.stateDir, "acpx");
    await openGatewayInstanceStore(ctx).register(ACPX_GATEWAY_INSTANCE_KEY, {
      instanceId: "gw-test",
      createdAt: 1,
    });
    const lease: AcpxProcessLease = {
      leaseId: "lease-probe-missing",
      gatewayInstanceId: "gw-test",
      sessionKey: ACPX_PROBE_LEASE_SESSION_KEY,
      wrapperRoot,
      wrapperPath: path.join(wrapperRoot, "codex-acp-wrapper.mjs"),
      rootPid: 0,
      commandHash: "hash",
      startedAt: 1,
      state: "open",
    };
    await openProcessLeaseStore(ctx).register(lease.leaseId, lease);
    const service = createAcpxRuntimeService(ctx, {
      runtimeFactory: () => runtime as never,
    });

    await service.start(ctx);

    await expect(openProcessLeaseStore(ctx).lookup(lease.leaseId)).resolves.toMatchObject({
      leaseId: lease.leaseId,
      rootPid: 0,
      state: "open",
    });
    await service.stop?.(ctx);
  });

  it("keeps startup quiet when no process leases are open", async () => {
    const workspaceDir = testWorkspace.dir;
    const ctx = createServiceContext(workspaceDir);
    const runtime = createMockRuntime();
    const service = createAcpxRuntimeService(ctx, {
      runtimeFactory: () => runtime as never,
    });

    await service.start(ctx);

    expect(cleanupAforaOwnedAcpxProcessTreeMock).not.toHaveBeenCalled();
    expect(ctx.logger.warn).not.toHaveBeenCalled();

    await service.stop?.(ctx);
  });

  it("registers the backend lazily without importing ACPX runtime when startup probe is disabled", async () => {
    process.env.AFORA_ACPX_RUNTIME_STARTUP_PROBE = "0";
    delete process.env.AFORA_SKIP_ACPX_RUNTIME_PROBE;
    const workspaceDir = testWorkspace.dir;
    const ctx = createServiceContext(workspaceDir);
    const service = createAcpxRuntimeService(ctx);

    await service.start(ctx);

    const backend = getAcpRuntimeBackend("acpx");
    if (!backend) {
      throw new Error("expected ACPX runtime backend");
    }
    const backendRuntime = backend.runtime as {
      ensureSession(input: { agent: string; mode: string; sessionKey: string }): Promise<unknown>;
    };
    expect(typeof backendRuntime.ensureSession).toBe("function");
    expect(backend.healthy).toBeUndefined();
    expect(acpxRuntimeConstructorMock).not.toHaveBeenCalled();

    await backendRuntime.ensureSession({
      agent: "codex",
      mode: "oneshot",
      sessionKey: "agent:codex:acp:test",
    });

    expect(acpxRuntimeConstructorMock).toHaveBeenCalledOnce();
    expect(backend.healthy).toBeUndefined();

    await service.stop?.(ctx);
  });

  it("forwards startTurn through the lazily resolved default runtime", async () => {
    process.env.AFORA_ACPX_RUNTIME_STARTUP_PROBE = "0";
    const workspaceDir = testWorkspace.dir;
    const ctx = createServiceContext(workspaceDir);
    const startTurn = vi.fn((input: { requestId: string }) => ({
      requestId: input.requestId,
      events: (async function* () {
        yield {
          type: "text_delta" as const,
          stream: "output" as const,
          text: "legacy progress",
        };
      })(),
      result: Promise.resolve({ status: "completed" as const, stopReason: "end_turn" }),
      cancel: vi.fn(async () => {}),
      closeStream: vi.fn(async () => {}),
    }));
    acpxRuntimeConstructorMock.mockImplementationOnce(function AcpxRuntime(options: unknown) {
      return {
        ...createMockRuntime({
          startTurn,
        }),
        getCapabilities: vi.fn(async () => ({ controls: [] })),
        getStatus: vi.fn(async () => ({ summary: "ready" })),
        prepareFreshSession: vi.fn(async () => {}),
        setConfigOption: vi.fn(async () => {}),
        setMode: vi.fn(async () => {}),
        __options: options,
      };
    });
    const service = createAcpxRuntimeService(ctx);

    await service.start(ctx);

    const backend = getAcpRuntimeBackend("acpx");
    if (!backend) {
      throw new Error("expected ACPX runtime backend");
    }
    const backendRuntime = backend.runtime as {
      startTurn(input: {
        handle: { sessionKey: string; backend: string; runtimeSessionName: string };
        text: string;
        mode: string;
        requestId: string;
      }): {
        events: AsyncIterable<unknown>;
        result: Promise<unknown>;
      };
    };
    const turn = backendRuntime.startTurn({
      handle: {
        sessionKey: "agent:codex:acp:test",
        backend: "acpx",
        runtimeSessionName: "agent:codex:acp:test",
      },
      text: "hello",
      mode: "prompt",
      requestId: "turn-1",
    });
    await expect(turn.result).resolves.toEqual({
      status: "completed",
      stopReason: "end_turn",
    });
    const events = [];
    for await (const event of turn.events) {
      events.push(event);
    }

    expect(events).toEqual([
      {
        type: "text_delta",
        stream: "output",
        text: "legacy progress",
      },
    ]);
    expect(startTurn).toHaveBeenCalledOnce();

    await service.stop?.(ctx);
  });

  it("passes the plugin timeout to the default acpx runtime constructor", async () => {
    process.env.AFORA_ACPX_RUNTIME_STARTUP_PROBE = "0";
    const workspaceDir = testWorkspace.dir;
    const ctx = createServiceContext(workspaceDir);
    const service = createAcpxRuntimeService(ctx, {
      pluginConfig: { timeoutSeconds: 0.001 },
    });

    await service.start(ctx);

    const backend = getAcpRuntimeBackend("acpx");
    if (!backend) {
      throw new Error("expected ACPX runtime backend");
    }
    const backendRuntime = backend.runtime as {
      ensureSession(input: { agent: string; mode: string; sessionKey: string }): Promise<unknown>;
    };

    await backendRuntime.ensureSession({
      agent: "codex",
      mode: "oneshot",
      sessionKey: "agent:codex:acp:test",
    });

    const [options] = acpxRuntimeConstructorMock.mock.calls[0] ?? [];
    expect(options).toHaveProperty("timeoutMs", 1);

    await service.stop?.(ctx);
  });

  it("caps oversized plugin timeouts before constructing the default acpx runtime", async () => {
    process.env.AFORA_ACPX_RUNTIME_STARTUP_PROBE = "0";
    const workspaceDir = testWorkspace.dir;
    const ctx = createServiceContext(workspaceDir);
    const service = createAcpxRuntimeService(ctx, {
      pluginConfig: { timeoutSeconds: Number.MAX_SAFE_INTEGER },
    });

    await service.start(ctx);

    const backend = getAcpRuntimeBackend("acpx");
    if (!backend) {
      throw new Error("expected ACPX runtime backend");
    }
    const backendRuntime = backend.runtime as {
      ensureSession(input: { agent: string; mode: string; sessionKey: string }): Promise<unknown>;
    };

    await backendRuntime.ensureSession({
      agent: "codex",
      mode: "oneshot",
      sessionKey: "agent:codex:acp:test",
    });

    const [options] = acpxRuntimeConstructorMock.mock.calls[0] ?? [];
    expect(options).toHaveProperty("timeoutMs", MAX_TIMER_TIMEOUT_MS);

    await service.stop?.(ctx);
  });

  it("runs the embedded runtime probe at startup when explicitly enabled and reports health", async () => {
    process.env.AFORA_ACPX_RUNTIME_STARTUP_PROBE = "1";
    const workspaceDir = testWorkspace.dir;
    const ctx = createServiceContext(workspaceDir);
    const probeAvailability = vi.fn(async () => {});
    const runtime = createMockRuntime({
      probeAvailability,
      isHealthy: () => true,
    });
    const service = createAcpxRuntimeService(ctx, {
      runtimeFactory: () => runtime as never,
    });

    await service.start(ctx);

    expect(probeAvailability).toHaveBeenCalledOnce();
    expect(getAcpRuntimeBackend("acpx")?.healthy?.()).toBe(true);

    await service.stop?.(ctx);
  });

  it("bounds the opt-in embedded runtime startup probe wait with the configured timeout", async () => {
    process.env.AFORA_ACPX_RUNTIME_STARTUP_PROBE = "1";
    const workspaceDir = testWorkspace.dir;
    const ctx = createServiceContext(workspaceDir);
    const probeAvailability = vi.fn(() => new Promise<void>(() => {}));
    const runtime = createMockRuntime({
      probeAvailability,
      isHealthy: () => false,
    });
    const service = createAcpxRuntimeService(ctx, {
      pluginConfig: { timeoutSeconds: 0.001 },
      runtimeFactory: () => runtime as never,
    });

    await service.start(ctx);

    expect(probeAvailability).toHaveBeenCalledOnce();
    expect(getAcpRuntimeBackend("acpx")?.healthy?.()).toBe(false);
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      "embedded acpx runtime setup failed: embedded acpx runtime backend startup probe timed out after 0.001s",
    );

    await service.stop?.(ctx);
  });

  it("passes the default runtime timeout to the embedded runtime factory", async () => {
    const workspaceDir = testWorkspace.dir;
    const ctx = createServiceContext(workspaceDir);
    const runtime = createMockRuntime();
    const runtimeFactory = vi.fn(() => runtime as never);
    const service = createAcpxRuntimeService(ctx, {
      runtimeFactory,
    });

    await service.start(ctx);

    expect(readFirstRuntimeFactoryInput(runtimeFactory).pluginConfig.timeoutSeconds).toBe(120);

    await service.stop?.(ctx);
  });

  it("uses the first allowed ACP agent as the default probe agent", async () => {
    const workspaceDir = testWorkspace.dir;
    const ctx = createServiceContext(workspaceDir);
    ctx.config = {
      acp: {
        allowedAgents: ["  OpenCode  ", "codex"],
      },
    };
    const runtime = createMockRuntime();
    const runtimeFactory = vi.fn(() => runtime as never);
    const service = createAcpxRuntimeService(ctx, {
      runtimeFactory,
    });

    await service.start(ctx);

    expect(readFirstRuntimeFactoryInput(runtimeFactory).pluginConfig.probeAgent).toBe("opencode");

    await service.stop?.(ctx);
  });

  it("keeps explicit probeAgent ahead of acp.allowedAgents", async () => {
    const workspaceDir = testWorkspace.dir;
    const ctx = createServiceContext(workspaceDir);
    ctx.config = {
      acp: {
        allowedAgents: ["opencode"],
      },
    };
    const runtime = createMockRuntime();
    const runtimeFactory = vi.fn(() => runtime as never);
    const service = createAcpxRuntimeService(ctx, {
      pluginConfig: { probeAgent: "codex" },
      runtimeFactory,
    });

    await service.start(ctx);

    expect(readFirstRuntimeFactoryInput(runtimeFactory).pluginConfig.probeAgent).toBe("codex");

    await service.stop?.(ctx);
  });

  it("lets the skip env override the opt-in embedded runtime startup probe without advertising health", async () => {
    process.env.AFORA_ACPX_RUNTIME_STARTUP_PROBE = "1";
    process.env.AFORA_SKIP_ACPX_RUNTIME_PROBE = "1";
    const workspaceDir = testWorkspace.dir;
    const ctx = createServiceContext(workspaceDir);
    const probeAvailability = vi.fn(async () => {});
    const runtime = createMockRuntime({
      doctor: async () => ({ ok: false, message: "nope" }),
      isHealthy: () => false,
      probeAvailability,
    });
    const service = createAcpxRuntimeService(ctx, {
      runtimeFactory: () => runtime as never,
    });

    await service.start(ctx);

    expect(probeAvailability).not.toHaveBeenCalled();
    expect(getAcpRuntimeBackend("acpx")?.runtime).toBe(runtime);
    expect(getAcpRuntimeBackend("acpx")?.healthy).toBeUndefined();

    await service.stop?.(ctx);
  });

  it("formats non-string doctor details without losing object payloads", async () => {
    process.env.AFORA_ACPX_RUNTIME_STARTUP_PROBE = "1";
    const workspaceDir = testWorkspace.dir;
    const ctx = createServiceContext(workspaceDir);
    const runtime = createMockRuntime({
      doctor: async () => ({
        ok: false,
        message: "probe failed",
        details: [{ code: "ACP_CLOSED", agent: "codex" }, new Error("stdin closed")],
      }),
      isHealthy: () => false,
    });
    const service = createAcpxRuntimeService(ctx, {
      runtimeFactory: () => runtime as never,
    });

    await service.start(ctx);

    expect(ctx.logger.warn).toHaveBeenCalledWith(
      'embedded acpx runtime backend probe failed: probe failed ({"code":"ACP_CLOSED","agent":"codex"}; stdin closed)',
    );

    await service.stop?.(ctx);
  });

  it("can skip the embedded runtime backend via env", async () => {
    process.env.AFORA_SKIP_ACPX_RUNTIME = "1";
    const workspaceDir = testWorkspace.dir;
    const ctx = createServiceContext(workspaceDir);
    const runtimeFactory = vi.fn(() => {
      throw new Error("runtime factory should not run when ACPX is skipped");
    });
    const service = createAcpxRuntimeService(ctx, {
      runtimeFactory: runtimeFactory as never,
    });

    await service.start(ctx);

    expect(runtimeFactory).not.toHaveBeenCalled();
    expect(getAcpRuntimeBackend("acpx")).toBeUndefined();
    expect(ctx.logger.info).toHaveBeenCalledWith(
      "skipping embedded acpx runtime backend (AFORA_SKIP_ACPX_RUNTIME=1)",
    );
  });
});
