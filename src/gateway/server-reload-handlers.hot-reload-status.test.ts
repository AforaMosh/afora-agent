/**
 * Proves `startManagedGatewayConfigReloader` forwards the underlying watcher's
 * live `hotReloadStatus()` accessor and owns cache invalidation at the accepted
 * candidate seam. This keeps request caching coupled to the actual watcher
 * lifecycle instead of individual config writers.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getRuntimeAuthProfileStoreCredentialsRevision } from "../agents/auth-profiles/runtime-snapshots.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayReloadPlan } from "./config-reload-plan.js";
import type { GatewayConfigReloadTransactionOwnership } from "./config-reload.js";
import {
  GatewayConfigReloadSupersededError,
  type GatewayPluginReloadResult,
} from "./server-reload-contracts.js";
import { startManagedGatewayConfigReloader } from "./server-reload-managed.js";

type ConfigAcceptedCallback = (
  nextConfig: OpenClawConfig,
  ownership: GatewayConfigReloadTransactionOwnership,
  sourceConfig: OpenClawConfig,
  acceptance: {
    runtimeApplied: boolean;
    publishSource?: () => Promise<() => Promise<void>>;
  },
) => void | (() => Promise<void>) | Promise<void | (() => Promise<void>)>;

const hoisted = vi.hoisted(() => ({
  hotReloadStatus: { current: "active" as "active" | "disabled" },
  invalidateConfigGetResponseCache: vi.fn(),
  onConfigCandidateCommitted: undefined as
    | ((info: {
        path: string;
        persistedHash: string | null;
        changedPaths: readonly string[];
      }) => void)
    | undefined,
  onConfigCandidateObserved: undefined as (() => void) | undefined,
  onConfigChange: undefined as
    | ((plan: GatewayReloadPlan, nextConfig: OpenClawConfig) => void | Promise<void>)
    | undefined,
  onConfigAccepted: undefined as ConfigAcceptedCallback | undefined,
  notifyPluginMetadataChanged: vi.fn(),
  stop: vi.fn(async () => {}),
  reloadHandlers: {
    applyHotReload: vi.fn(async () => {}),
    acceptRestartConfig: vi.fn(() => ({ retireRejectedRestart: false })),
    beginGatewayRestartLifecycle: vi.fn(() => ({ settle: vi.fn() })),
    pauseGatewayRestartForConfigCandidate: vi.fn(),
    publishAppliedConfigHash: vi.fn(),
    publishAcceptedRestartTarget: vi.fn(() => ({
      ownership: { reject: vi.fn() },
      conservativeDebt: null,
    })),
    publishDeferredAppliedConfigHash: vi.fn(),
    recordAcceptedRestartTarget: vi.fn(() => ({ reject: vi.fn() })),
    requestGatewayRestart: vi.fn(() => ({
      status: "accepted" as const,
      settle: vi.fn(),
    })),
    restoreConservativeRestartDebt: vi.fn(),
    stopRestartRetries: vi.fn(),
  },
  createGatewayReloadHandlers: vi.fn(),
}));

vi.mock("./config-get-response.js", () => ({
  invalidateConfigGetResponseCache: hoisted.invalidateConfigGetResponseCache,
}));

vi.mock("./server-reload-hot.js", () => ({
  createGatewayReloadHandlers: hoisted.createGatewayReloadHandlers,
}));

vi.mock("./config-reload.js", async () => {
  const actual = await vi.importActual<typeof import("./config-reload.js")>("./config-reload.js");
  return {
    ...actual,
    startGatewayConfigReloader: vi.fn(
      (options: {
        onConfigCandidateCommitted?: (info: {
          path: string;
          persistedHash: string | null;
          changedPaths: readonly string[];
        }) => void;
        onConfigCandidateObserved?: () => void;
        onConfigChange?: (
          plan: GatewayReloadPlan,
          nextConfig: OpenClawConfig,
        ) => void | Promise<void>;
        onConfigAccepted?: ConfigAcceptedCallback;
      }) => {
        hoisted.onConfigCandidateCommitted = options.onConfigCandidateCommitted;
        hoisted.onConfigCandidateObserved = options.onConfigCandidateObserved;
        hoisted.onConfigChange = options.onConfigChange;
        hoisted.onConfigAccepted = options.onConfigAccepted;
        return {
          stop: hoisted.stop,
          hotReloadStatus: () => hoisted.hotReloadStatus.current,
          notifyPluginMetadataChanged: hoisted.notifyPluginMetadataChanged,
        };
      },
    ),
  };
});

type ManagedReloaderParams = Parameters<typeof startManagedGatewayConfigReloader>[0];

function startTestManagedReloader(overrides: Partial<ManagedReloaderParams> = {}) {
  const initialConfig = { session: { store: "/tmp/sessions.json" } } as OpenClawConfig;
  return startManagedGatewayConfigReloader({
    minimalTestGateway: false,
    initialConfig,
    initialCompareConfig: initialConfig,
    initialSnapshotRawHash: null,
    initialAuthoredConfig: {},
    initialSnapshotValid: true,
    initialSnapshotIssues: [],
    initialInternalWriteHash: null,
    watchPath: "/tmp/openclaw.json",
    readSnapshot: vi.fn() as never,
    promoteSnapshot: vi.fn(async () => true) as never,
    subscribeToWrites: vi.fn(() => () => {}) as never,
    deps: {} as never,
    broadcast: vi.fn(),
    getState: () => ({
      hooksConfig: {} as never,
      hookClientIpConfig: {} as never,
      heartbeatRunner: { stop: vi.fn(), updateConfig: vi.fn() } as never,
      cronState: {
        cron: { start: vi.fn(async () => {}), stop: vi.fn() },
        storePath: "/tmp/cron.json",
        cronEnabled: false,
      } as never,
      channelHealthMonitor: null,
    }),
    setState: vi.fn(),
    startChannel: vi.fn(async () => {}),
    stopChannel: vi.fn(async () => {}),
    reloadPlugins: vi.fn(
      async (): Promise<GatewayPluginReloadResult> => ({
        restartChannels: new Set(),
        activeChannels: new Set(),
      }),
    ),
    logHooks: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    logChannels: { info: vi.fn(), error: vi.fn() },
    logCron: { error: vi.fn() },
    logReload: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    cronReconciliation: {
      arm: () => ({ complete: async () => {} }),
      invalidate: vi.fn(),
    },
    channelManager: {} as never,
    activateRuntimeSecrets: vi.fn(async (config: OpenClawConfig) => ({
      sourceConfig: config,
      config,
      authStores: [],
      authStoreCredentialsRevision: getRuntimeAuthProfileStoreCredentialsRevision(),
      warnings: [],
      webTools: {},
    })) as never,
    resolveSharedGatewaySessionGenerationForConfig: () => undefined,
    sharedGatewaySessionGenerationState: { current: undefined, required: null },
    prepareTerminalConfig: vi.fn(),
    reconcileTerminalSessions: vi.fn(),
    commitTerminalConfig: vi.fn(),
    acceptTerminalConfig: vi.fn(),
    clients: [],
    ...overrides,
  });
}

function createHotReloadPlan(): GatewayReloadPlan {
  return {
    changedPaths: ["logging.level"],
    restartGateway: false,
    restartReasons: [],
    hotReasons: ["logging.level"],
    reloadHooks: false,
    restartGmailWatcher: false,
    restartCron: false,
    restartHeartbeat: false,
    restartHealthMonitor: false,
    reloadPlugins: false,
    restartChannels: new Set(),
    disposeMcpRuntimes: false,
    noopPaths: [],
  };
}

describe("startManagedGatewayConfigReloader hotReloadStatus plumbing", () => {
  beforeEach(() => {
    hoisted.hotReloadStatus.current = "active";
    hoisted.onConfigCandidateCommitted = undefined;
    hoisted.onConfigCandidateObserved = undefined;
    hoisted.onConfigChange = undefined;
    hoisted.onConfigAccepted = undefined;
    hoisted.invalidateConfigGetResponseCache.mockClear();
    hoisted.notifyPluginMetadataChanged.mockClear();
    hoisted.stop.mockClear();
    hoisted.reloadHandlers.pauseGatewayRestartForConfigCandidate.mockClear();
    hoisted.reloadHandlers.stopRestartRetries.mockClear();
    hoisted.createGatewayReloadHandlers.mockReset();
    hoisted.createGatewayReloadHandlers.mockReturnValue(hoisted.reloadHandlers);
  });

  it("forwards live status and invalidates config.get on watcher commit", async () => {
    const broadcast = vi.fn();
    const reloader = startTestManagedReloader({ broadcast });

    expect(reloader.hotReloadStatus).toBeTypeOf("function");
    expect(reloader.hotReloadStatus?.()).toBe("active");
    expect(hoisted.createGatewayReloadHandlers).not.toHaveBeenCalled();

    // Flip the underlying watcher's live state without recreating the managed
    // handle — a copied/snapshotted value would stay stuck on "active".
    hoisted.hotReloadStatus.current = "disabled";
    expect(reloader.hotReloadStatus?.()).toBe("disabled");

    hoisted.onConfigCandidateCommitted?.({
      path: "/tmp/openclaw.json",
      persistedHash: "persisted-1",
      changedPaths: ["gateway.port"],
    });
    expect(hoisted.invalidateConfigGetResponseCache).toHaveBeenCalledOnce();
    expect(broadcast).toHaveBeenCalledWith(
      "config.changed",
      { path: "/tmp/openclaw.json", hash: "persisted-1", ts: expect.any(Number) },
      { dropIfSlow: true },
    );

    await reloader.stop();
    expect(hoisted.stop).toHaveBeenCalledOnce();
    expect(hoisted.createGatewayReloadHandlers).not.toHaveBeenCalled();
    expect(hoisted.reloadHandlers.stopRestartRetries).not.toHaveBeenCalled();
  });

  it("accepts a baseline-only transaction without loading handlers", async () => {
    const reloader = startTestManagedReloader();
    const onConfigAccepted = hoisted.onConfigAccepted;
    if (!onConfigAccepted) {
      throw new Error("Expected managed reloader to register onConfigAccepted");
    }
    const config = { logging: { level: "info" } } as OpenClawConfig;
    const rollback = vi.fn(async () => {});
    const publishSource = vi.fn(async () => rollback);
    const ownership = {
      isCurrent: () => true,
      reapplyRuntimeOverlays: (candidate: OpenClawConfig) => candidate,
      publishRuntimeEnv: vi.fn(),
      rollbackRuntimeEnv: vi.fn(),
      commitRuntimeEnv: vi.fn(),
      markRuntimeCommitted: vi.fn(),
    } satisfies GatewayConfigReloadTransactionOwnership;

    await expect(
      onConfigAccepted(config, ownership, config, {
        runtimeApplied: true,
        publishSource,
      }),
    ).resolves.toBe(rollback);

    expect(publishSource).toHaveBeenCalledOnce();
    expect(hoisted.createGatewayReloadHandlers).not.toHaveBeenCalled();
    await reloader.stop();
  });

  it("does not load handlers when a pending candidate is stopped before reload", async () => {
    const reloader = startTestManagedReloader();

    hoisted.onConfigCandidateObserved?.();
    await reloader.stop();

    expect(hoisted.createGatewayReloadHandlers).not.toHaveBeenCalled();
    expect(hoisted.reloadHandlers.stopRestartRetries).not.toHaveBeenCalled();
  });

  it("preserves the first lazy initialization error", async () => {
    const reloader = startTestManagedReloader();
    const loadError = new Error("hot reload module unavailable");
    hoisted.createGatewayReloadHandlers.mockImplementationOnce(() => {
      throw loadError;
    });

    const onConfigChange = hoisted.onConfigChange;
    if (!onConfigChange) {
      throw new Error("Expected managed reloader to register onConfigChange");
    }
    const plan = createHotReloadPlan();
    await expect(onConfigChange(plan, {})).rejects.toBe(loadError);
    await expect(onConfigChange(plan, {})).rejects.toBe(loadError);

    expect(hoisted.createGatewayReloadHandlers).toHaveBeenCalledOnce();
    await reloader.stop();
  });

  it("supersedes a lazy initialization failure after shutdown starts", async () => {
    const reloader = startTestManagedReloader();
    const loadError = new Error("hot reload module unavailable during shutdown");
    hoisted.createGatewayReloadHandlers.mockImplementationOnce(() => {
      throw loadError;
    });
    const onConfigChange = hoisted.onConfigChange;
    if (!onConfigChange) {
      throw new Error("Expected managed reloader to register onConfigChange");
    }

    const reload = onConfigChange(createHotReloadPlan(), {});
    const stop = reloader.stop();

    await expect(reload).rejects.toBeInstanceOf(GatewayConfigReloadSupersededError);
    await stop;
    expect(hoisted.createGatewayReloadHandlers).toHaveBeenCalledOnce();
    expect(hoisted.reloadHandlers.stopRestartRetries).not.toHaveBeenCalled();
  });

  it("stops a handler generation that resolves during shutdown", async () => {
    const prepareTerminalConfig = vi.fn();
    const reloader = startTestManagedReloader({ prepareTerminalConfig });
    const onConfigChange = hoisted.onConfigChange;
    if (!onConfigChange) {
      throw new Error("Expected managed reloader to register onConfigChange");
    }

    const reload = onConfigChange(createHotReloadPlan(), {});
    const stop = reloader.stop();

    await expect(reload).rejects.toThrow("config reload superseded");
    await stop;
    expect(hoisted.createGatewayReloadHandlers).toHaveBeenCalledOnce();
    expect(hoisted.reloadHandlers.stopRestartRetries).toHaveBeenCalledOnce();
    expect(prepareTerminalConfig).not.toHaveBeenCalled();
  });

  it("supersedes the first reload when another candidate arrives during initialization", async () => {
    const prepareTerminalConfig = vi.fn();
    const reloader = startTestManagedReloader({ prepareTerminalConfig });
    const onConfigChange = hoisted.onConfigChange;
    if (!onConfigChange) {
      throw new Error("Expected managed reloader to register onConfigChange");
    }
    const plan = createHotReloadPlan();
    const firstConfig = { logging: { level: "info" } } as OpenClawConfig;
    const secondConfig = { logging: { level: "debug" } } as OpenClawConfig;

    hoisted.onConfigCandidateObserved?.();
    const firstReload = onConfigChange(plan, firstConfig);
    hoisted.onConfigCandidateObserved?.();

    await expect(firstReload).rejects.toThrow("config reload superseded");
    await onConfigChange(plan, secondConfig);

    expect(hoisted.createGatewayReloadHandlers).toHaveBeenCalledOnce();
    expect(hoisted.reloadHandlers.pauseGatewayRestartForConfigCandidate).toHaveBeenCalledOnce();
    expect(prepareTerminalConfig).toHaveBeenCalledOnce();
    expect(prepareTerminalConfig).toHaveBeenCalledWith(plan, secondConfig);

    await reloader.stop();
  });

  it("creates one handler generation on the first valid reload", async () => {
    const initialConfig = { session: { store: "/tmp/sessions.json" } } as OpenClawConfig;
    const prepareTerminalConfig = vi.fn();
    const reloader = startTestManagedReloader({ prepareTerminalConfig });

    hoisted.onConfigCandidateObserved?.();
    expect(hoisted.createGatewayReloadHandlers).not.toHaveBeenCalled();

    const onConfigChange = hoisted.onConfigChange;
    if (!onConfigChange) {
      throw new Error("Expected managed reloader to register onConfigChange");
    }
    const plan = createHotReloadPlan();
    await Promise.all([onConfigChange(plan, initialConfig), onConfigChange(plan, initialConfig)]);

    expect(hoisted.createGatewayReloadHandlers).toHaveBeenCalledOnce();
    expect(hoisted.reloadHandlers.pauseGatewayRestartForConfigCandidate).toHaveBeenCalledOnce();
    expect(prepareTerminalConfig).toHaveBeenCalledTimes(2);

    hoisted.onConfigCandidateObserved?.();
    expect(hoisted.reloadHandlers.pauseGatewayRestartForConfigCandidate).toHaveBeenCalledTimes(2);

    await reloader.stop();
    expect(hoisted.reloadHandlers.stopRestartRetries).toHaveBeenCalledOnce();
  });
});
