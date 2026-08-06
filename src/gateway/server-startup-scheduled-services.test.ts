import { describe, expect, it, vi } from "vitest";
import { createDeferred, type Deferred } from "../shared/deferred.js";
import { createGatewayScheduledServicesController } from "./server-startup-scheduled-services.js";

type ControllerParams = Parameters<typeof createGatewayScheduledServicesController>[0];
type ScheduledServicesModule = Awaited<
  ReturnType<NonNullable<ControllerParams["loadScheduledServicesModule"]>>
>;

function createHarness(
  options: {
    moduleLoad?: Deferred<ScheduledServicesModule>;
    sessionDeliveryRecoveryMaxEnqueuedAt?: number;
    minimalTestGateway?: boolean;
    stopPostReadyMaintenance?: () => Promise<void>;
    stopRetainedPluginCleanup?: () => Promise<void>;
  } = {},
) {
  const postReady = createDeferred();
  let currentConfig = { marker: "initial" } as never;
  let currentCronState = { marker: "initial-cron" } as never;
  const activeHeartbeatRunner = {
    updateConfig: vi.fn(),
    stop: vi.fn(),
  };
  const stopOutboundDeliveryRecovery = vi.fn(async () => {});
  const activateGatewayScheduledServices = vi.fn(() => ({
    heartbeatRunner: activeHeartbeatRunner,
    stopOutboundDeliveryRecovery,
  }));
  const stopPostReadyMaintenance = vi.fn(options.stopPostReadyMaintenance ?? (async () => {}));
  const scheduleGatewayPostReadyMaintenance = vi.fn(() => {
    return { stop: stopPostReadyMaintenance };
  });
  const stopRetainedPluginCleanup = vi.fn(options.stopRetainedPluginCleanup ?? (async () => {}));
  const scheduleGatewayIdleTask = vi.fn(() => ({ stop: stopRetainedPluginCleanup }));
  const recordPostReadyMemory = vi.fn();
  const runtimeModule = {
    activateGatewayScheduledServices,
    scheduleGatewayPostReadyMaintenance,
    scheduleGatewayIdleTask,
  } as ScheduledServicesModule;
  const loadScheduledServicesModule = vi.fn(
    () => options.moduleLoad?.promise ?? Promise.resolve(runtimeModule),
  );
  const log = {
    child: vi.fn(() => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    })),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const controller = createGatewayScheduledServicesController({
    minimalTestGateway: options.minimalTestGateway ?? false,
    deps: {} as never,
    getConfig: () => currentConfig,
    getCronState: () => currentCronState,
    waitForPostReadyWork: () => postReady.promise,
    sessionDeliveryRecoveryMaxEnqueuedAt: options.sessionDeliveryRecoveryMaxEnqueuedAt ?? 123,
    cronReconciliation: {} as never,
    shouldStartCron: () => true,
    markCronStartHandled: vi.fn(),
    startMaintenance: vi.fn(async () => null),
    applyMaintenance: vi.fn(),
    recordPostReadyMemory,
    logCron: { error: vi.fn() },
    log,
    loadScheduledServicesModule,
  });

  return {
    controller,
    postReady,
    runtimeModule,
    loadScheduledServicesModule,
    activateGatewayScheduledServices,
    scheduleGatewayPostReadyMaintenance,
    scheduleGatewayIdleTask,
    activeHeartbeatRunner,
    stopOutboundDeliveryRecovery,
    stopPostReadyMaintenance,
    stopRetainedPluginCleanup,
    recordPostReadyMemory,
    log,
    setCurrentConfig: (config: unknown) => {
      currentConfig = config as never;
    },
    setCurrentCronState: (cronState: unknown) => {
      currentCronState = cronState as never;
    },
  };
}

async function waitForActivation(harness: ReturnType<typeof createHarness>): Promise<void> {
  await vi.waitFor(() => {
    expect(harness.activateGatewayScheduledServices).toHaveBeenCalledTimes(1);
  });
}

describe("gateway scheduled services startup controller", () => {
  it("samples post-ready memory in minimal mode without sidecars or a runtime import", async () => {
    const harness = createHarness({ minimalTestGateway: true });

    await Promise.resolve();
    expect(harness.recordPostReadyMemory).not.toHaveBeenCalled();

    harness.postReady.resolve();
    await vi.waitFor(() => {
      expect(harness.recordPostReadyMemory).toHaveBeenCalledTimes(1);
    });

    expect(harness.loadScheduledServicesModule).not.toHaveBeenCalled();
    expect(harness.activateGatewayScheduledServices).not.toHaveBeenCalled();
    await harness.controller.stop();
  });

  it.each(["post-ready-first", "sidecars-first"] as const)(
    "returns immediately and waits for both latches when %s",
    async (order) => {
      const harness = createHarness();

      if (order === "post-ready-first") {
        harness.postReady.resolve();
      } else {
        harness.controller.markSidecarsReady();
      }
      await Promise.resolve();
      await Promise.resolve();

      expect(harness.loadScheduledServicesModule).not.toHaveBeenCalled();

      if (order === "post-ready-first") {
        harness.controller.markSidecarsReady();
      } else {
        harness.postReady.resolve();
      }
      await waitForActivation(harness);

      expect(harness.loadScheduledServicesModule).toHaveBeenCalledTimes(1);
      expect(harness.scheduleGatewayPostReadyMaintenance).toHaveBeenCalledTimes(1);
      expect(harness.scheduleGatewayIdleTask).toHaveBeenCalledTimes(1);
      await harness.controller.stop();
    },
  );

  it("activates once with current config, current cron state, and the bind-time cutoff", async () => {
    const harness = createHarness({ sessionDeliveryRecoveryMaxEnqueuedAt: 456 });
    const currentConfig = { marker: "current" };
    const acceptedHeartbeatConfig = { marker: "current" };
    const currentCronState = { marker: "current-cron" };
    const stableHeartbeatRunner = harness.controller.heartbeatRunner;
    harness.setCurrentConfig(currentConfig);
    harness.setCurrentCronState(currentCronState);
    stableHeartbeatRunner.updateConfig(acceptedHeartbeatConfig as never);

    harness.controller.markSidecarsReady();
    harness.postReady.resolve();
    await waitForActivation(harness);

    expect(harness.activateGatewayScheduledServices).toHaveBeenCalledWith(
      expect.objectContaining({
        cfgAtStart: currentConfig,
        cronState: currentCronState,
        sessionDeliveryRecoveryMaxEnqueuedAt: 456,
        startCron: false,
      }),
    );
    expect(harness.activeHeartbeatRunner.updateConfig).toHaveBeenCalledWith(
      acceptedHeartbeatConfig,
    );
    expect(harness.controller.heartbeatRunner).toBe(stableHeartbeatRunner);

    const laterConfig = { marker: "later" };
    stableHeartbeatRunner.updateConfig(laterConfig as never);
    expect(harness.activeHeartbeatRunner.updateConfig).toHaveBeenLastCalledWith(laterConfig);
    await harness.controller.stop();
  });

  it("keeps repeated readiness signals to one import and activation", async () => {
    const harness = createHarness();

    harness.controller.markSidecarsReady();
    harness.controller.markSidecarsReady();
    harness.postReady.resolve();
    harness.postReady.resolve();
    await waitForActivation(harness);
    harness.controller.markSidecarsReady();
    await Promise.resolve();

    expect(harness.loadScheduledServicesModule).toHaveBeenCalledTimes(1);
    expect(harness.activateGatewayScheduledServices).toHaveBeenCalledTimes(1);
    await harness.controller.stop();
  });

  it("lets close win before the post-ready barrier", async () => {
    const harness = createHarness();

    const firstStop = harness.controller.stop();
    const secondStop = harness.controller.stop();
    expect(secondStop).toBe(firstStop);
    await firstStop;

    harness.controller.markSidecarsReady();
    harness.postReady.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.loadScheduledServicesModule).not.toHaveBeenCalled();
    expect(harness.activateGatewayScheduledServices).not.toHaveBeenCalled();
  });

  it("joins a pending import and prevents late activation after close", async () => {
    const moduleLoad = createDeferred<ScheduledServicesModule>();
    const harness = createHarness({ moduleLoad });
    harness.controller.markSidecarsReady();
    harness.postReady.resolve();
    await vi.waitFor(() => {
      expect(harness.loadScheduledServicesModule).toHaveBeenCalledTimes(1);
    });

    let stopSettled = false;
    const stop = harness.controller.stop().then(() => {
      stopSettled = true;
    });
    await Promise.resolve();
    expect(stopSettled).toBe(false);

    moduleLoad.resolve(harness.runtimeModule);
    await stop;

    expect(harness.activateGatewayScheduledServices).not.toHaveBeenCalled();
    expect(harness.scheduleGatewayPostReadyMaintenance).not.toHaveBeenCalled();
    expect(harness.scheduleGatewayIdleTask).not.toHaveBeenCalled();
  });

  it("stops activated services and deferred cleanup once", async () => {
    const harness = createHarness();
    harness.controller.markSidecarsReady();
    harness.postReady.resolve();
    await waitForActivation(harness);

    const firstStop = harness.controller.stop();
    const secondStop = harness.controller.stop();
    expect(secondStop).toBe(firstStop);
    await firstStop;
    harness.controller.heartbeatRunner.stop();
    await harness.controller.stopOutboundDeliveryRecovery();

    expect(harness.activeHeartbeatRunner.stop).toHaveBeenCalledTimes(1);
    expect(harness.stopOutboundDeliveryRecovery).toHaveBeenCalledTimes(1);
    expect(harness.stopPostReadyMaintenance).toHaveBeenCalledTimes(1);
    expect(harness.stopRetainedPluginCleanup).toHaveBeenCalledTimes(1);
  });

  it("joins already-started scheduled children before the lifecycle stop settles", async () => {
    const maintenance = createDeferred();
    const retainedCleanup = createDeferred();
    const harness = createHarness({
      stopPostReadyMaintenance: () => maintenance.promise,
      stopRetainedPluginCleanup: () => retainedCleanup.promise,
    });
    harness.controller.markSidecarsReady();
    harness.postReady.resolve();
    await waitForActivation(harness);

    let stopSettled = false;
    const stop = harness.controller.stop().then(() => {
      stopSettled = true;
    });
    await vi.waitFor(() => {
      expect(harness.stopPostReadyMaintenance).toHaveBeenCalledTimes(1);
      expect(harness.stopRetainedPluginCleanup).toHaveBeenCalledTimes(1);
    });
    expect(stopSettled).toBe(false);

    maintenance.resolve();
    await Promise.resolve();
    expect(stopSettled).toBe(false);

    retainedCleanup.resolve();
    await stop;
    expect(stopSettled).toBe(true);
  });

  it("reports a cached module rejection through the lifecycle owner", async () => {
    const moduleLoad = createDeferred<ScheduledServicesModule>();
    const harness = createHarness({ moduleLoad });
    harness.controller.markSidecarsReady();
    harness.postReady.resolve();
    await vi.waitFor(() => {
      expect(harness.loadScheduledServicesModule).toHaveBeenCalledTimes(1);
    });

    moduleLoad.reject(new Error("module unavailable"));
    await vi.waitFor(() => {
      expect(harness.log.error).toHaveBeenCalledWith(
        "gateway scheduled services failed to start: Error: module unavailable",
      );
    });
    await expect(harness.controller.stop()).resolves.toBeUndefined();

    expect(harness.loadScheduledServicesModule).toHaveBeenCalledTimes(1);
    expect(harness.activateGatewayScheduledServices).not.toHaveBeenCalled();
    expect(harness.scheduleGatewayPostReadyMaintenance).not.toHaveBeenCalled();
  });
});
