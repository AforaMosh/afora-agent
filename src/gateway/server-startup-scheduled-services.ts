import type { CliDeps } from "../cli/deps.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { HeartbeatRunner } from "../infra/heartbeat-runner.js";
import { getActiveGatewayRootWorkCount } from "../process/gateway-work-admission.js";
import { createDeferred } from "../shared/deferred.js";
import { createLazyPromise } from "../shared/lazy-runtime.js";
import type { GatewayCronReconciliation } from "./server-cron-reconciled.js";
import type { GatewayCronState } from "./server-cron.js";
import type { GatewayRuntimeServiceLogger } from "./server-runtime-service-shared.js";
import type {
  GatewayMaintenanceHandles,
  GatewayIdleTaskHandle,
  GatewayPostReadyMaintenanceHandle,
} from "./server-runtime-services.js";

const POST_READY_MAINTENANCE_DELAY_MS = 250;
const RETAINED_PLUGIN_CLEANUP_DELAY_MS = 30_000;

type GatewayScheduledServicesModule = Pick<
  typeof import("./server-runtime-services.js"),
  | "activateGatewayScheduledServices"
  | "scheduleGatewayIdleTask"
  | "scheduleGatewayPostReadyMaintenance"
>;

type GatewayScheduledServicesLogger = GatewayRuntimeServiceLogger & {
  warn: (message: string) => void;
};

type GatewayScheduledServicesController = {
  heartbeatRunner: HeartbeatRunner;
  stopOutboundDeliveryRecovery: () => Promise<void>;
  markSidecarsReady: () => void;
  stop: () => Promise<void>;
};

export type GatewayScheduledServicesLifecycleOwner = Pick<
  GatewayScheduledServicesController,
  "stop"
>;

/** Owns deferred scheduled-service activation and every handle it publishes. */
export function createGatewayScheduledServicesController(params: {
  minimalTestGateway: boolean;
  deps: CliDeps;
  getConfig: () => OpenClawConfig;
  getCronState: () => GatewayCronState;
  waitForPostReadyWork: () => Promise<void>;
  sessionDeliveryRecoveryMaxEnqueuedAt: number;
  cronReconciliation: GatewayCronReconciliation;
  shouldStartCron: () => boolean;
  markCronStartHandled: () => void;
  startMaintenance: () => Promise<GatewayMaintenanceHandles | null>;
  applyMaintenance: (maintenance: GatewayMaintenanceHandles) => Promise<void> | void;
  recordPostReadyMemory: () => void;
  logCron: { error: (message: string) => void };
  log: GatewayScheduledServicesLogger;
  loadScheduledServicesModule?: () => Promise<GatewayScheduledServicesModule>;
}): GatewayScheduledServicesController {
  const sidecarsReady = createDeferred();
  const closeStarted = createDeferred();
  const loadScheduledServicesModule = createLazyPromise(
    params.loadScheduledServicesModule ?? (() => import("./server-runtime-services.js")),
    { cacheRejections: true },
  );

  let stopped = false;
  let sidecarsReadyMarked = false;
  let activeHeartbeatRunner: HeartbeatRunner | null = null;
  let activeHeartbeatStopped = false;
  let pendingHeartbeatConfig: OpenClawConfig | null = null;
  let activeOutboundRecoveryStop: (() => Promise<void>) | null = null;
  let outboundRecoveryStopRequested = false;
  let outboundRecoveryStopPromise: Promise<void> | null = null;
  let maintenanceHandle: GatewayPostReadyMaintenanceHandle | null = null;
  let maintenanceStopPromise: Promise<void> | null = null;
  let retainedPluginCleanupHandle: GatewayIdleTaskHandle | null = null;
  let retainedPluginCleanupStopPromise: Promise<void> | null = null;
  let stopPromise: Promise<void> | null = null;

  const stopActiveHeartbeat = () => {
    if (activeHeartbeatStopped || !activeHeartbeatRunner) {
      return;
    }
    activeHeartbeatStopped = true;
    activeHeartbeatRunner.stop();
  };

  const stopOutboundDeliveryRecovery = (): Promise<void> => {
    outboundRecoveryStopRequested = true;
    if (outboundRecoveryStopPromise) {
      return outboundRecoveryStopPromise;
    }
    if (!activeOutboundRecoveryStop) {
      return Promise.resolve();
    }
    outboundRecoveryStopPromise = activeOutboundRecoveryStop();
    return outboundRecoveryStopPromise;
  };

  const heartbeatRunner: HeartbeatRunner = {
    updateConfig: (config) => {
      if (stopped) {
        return;
      }
      if (activeHeartbeatRunner) {
        activeHeartbeatRunner.updateConfig(config);
        return;
      }
      // Reload can commit before the post-ready barrier opens. Retain that
      // accepted config until the real runner exists instead of dropping it.
      pendingHeartbeatConfig = config;
    },
    stop: () => {
      void stop();
    },
  };

  const waitForActivationGate = async (): Promise<boolean> => {
    const activationReady = params.minimalTestGateway
      ? params.waitForPostReadyWork().then(() => true)
      : Promise.all([params.waitForPostReadyWork(), sidecarsReady.promise]).then(() => true);
    return await Promise.race([activationReady, closeStarted.promise.then(() => false)]);
  };

  const schedulePostReadyWork = (
    gatewayRuntimeServices: GatewayScheduledServicesModule,
    cronState: GatewayCronState,
    config: OpenClawConfig,
  ) => {
    maintenanceHandle = gatewayRuntimeServices.scheduleGatewayPostReadyMaintenance({
      delayMs: POST_READY_MAINTENANCE_DELAY_MS,
      isClosing: () => stopped,
      startMaintenance: params.startMaintenance,
      applyMaintenance: params.applyMaintenance,
      shouldStartCron: () => !stopped && params.shouldStartCron(),
      markCronStartHandled: params.markCronStartHandled,
      cronState,
      cronReconciliation: params.cronReconciliation,
      cronConfig: config,
      logCron: params.logCron,
      log: params.log,
      recordPostReadyMemory: params.recordPostReadyMemory,
    });
    // Resolve install paths only in the idle task. The active plugin
    // generation can change between startup and cleanup.
    retainedPluginCleanupHandle = gatewayRuntimeServices.scheduleGatewayIdleTask({
      delayMs: RETAINED_PLUGIN_CLEANUP_DELAY_MS,
      retryDelayMs: RETAINED_PLUGIN_CLEANUP_DELAY_MS,
      isClosing: () => stopped,
      isBusy: () => getActiveGatewayRootWorkCount({ excludeCurrent: true }) > 0,
      run: async () => {
        const { cleanupRetainedPluginInstallGenerations } =
          await import("./server-retained-plugin-cleanup.js");
        await cleanupRetainedPluginInstallGenerations({ log: params.log });
      },
      log: params.log,
      errorMessage: "retained npm generation cleanup failed",
    });
  };

  const stopPublishedScheduledChildren = async (): Promise<void> => {
    if (maintenanceHandle && !maintenanceStopPromise) {
      maintenanceStopPromise = maintenanceHandle.stop();
    }
    if (retainedPluginCleanupHandle && !retainedPluginCleanupStopPromise) {
      retainedPluginCleanupStopPromise = retainedPluginCleanupHandle.stop();
    }
    await Promise.all([maintenanceStopPromise, retainedPluginCleanupStopPromise]);
  };

  const activationTask = (async () => {
    if (!(await waitForActivationGate()) || stopped) {
      return;
    }
    if (params.minimalTestGateway) {
      params.recordPostReadyMemory();
      return;
    }
    const gatewayRuntimeServices = await loadScheduledServicesModule();
    if (stopped) {
      return;
    }
    const config = params.getConfig();
    const cronState = params.getCronState();
    const activated = gatewayRuntimeServices.activateGatewayScheduledServices({
      minimalTestGateway: params.minimalTestGateway,
      cfgAtStart: config,
      deps: params.deps,
      sessionDeliveryRecoveryMaxEnqueuedAt: params.sessionDeliveryRecoveryMaxEnqueuedAt,
      cronState,
      cronReconciliation: params.cronReconciliation,
      startCron: false,
      logCron: params.logCron,
      log: params.log,
    });
    activeHeartbeatRunner = activated.heartbeatRunner;
    activeOutboundRecoveryStop = activated.stopOutboundDeliveryRecovery;
    const retainedHeartbeatConfig = pendingHeartbeatConfig;
    pendingHeartbeatConfig = null;
    if (retainedHeartbeatConfig && retainedHeartbeatConfig !== config) {
      activeHeartbeatRunner.updateConfig(retainedHeartbeatConfig);
    }
    if (outboundRecoveryStopRequested) {
      void stopOutboundDeliveryRecovery();
    }
    schedulePostReadyWork(gatewayRuntimeServices, cronState, config);
  })().catch((error: unknown) => {
    params.log.error(`gateway scheduled services failed to start: ${String(error)}`);
  });

  const stop = (): Promise<void> => {
    if (stopPromise) {
      return stopPromise;
    }
    stopped = true;
    closeStarted.resolve();
    const scheduledChildrenStop = stopPublishedScheduledChildren();
    stopActiveHeartbeat();
    stopPromise = Promise.all([activationTask, scheduledChildrenStop]).then(async () => {
      // Import can settle after close starts. Recheck the late-published
      // delegates before resolving the lifecycle fence.
      stopActiveHeartbeat();
      await Promise.all([stopPublishedScheduledChildren(), stopOutboundDeliveryRecovery()]);
    });
    return stopPromise;
  };

  return {
    heartbeatRunner,
    stopOutboundDeliveryRecovery,
    markSidecarsReady: () => {
      if (sidecarsReadyMarked) {
        return;
      }
      sidecarsReadyMarked = true;
      sidecarsReady.resolve();
    },
    stop,
  };
}
