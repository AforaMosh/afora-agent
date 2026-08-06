import { runWithGatewayIndependentRootWorkAdmission } from "../process/gateway-work-admission.js";

type GatewayIdleTaskLogger = {
  warn: (message: string) => void;
};

export type GatewayIdleTaskHandle = {
  stop: () => Promise<void>;
};

/** Schedules one low-priority task, retrying until the gateway has no active request roots. */
export function scheduleGatewayIdleTask(params: {
  delayMs: number;
  retryDelayMs: number;
  isClosing: () => boolean;
  isBusy: () => boolean;
  run: () => Promise<void>;
  log: GatewayIdleTaskLogger;
  errorMessage: string;
}): GatewayIdleTaskHandle {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> | null = null;
  let stopPromise: Promise<void> | null = null;
  const schedule = (delayMs: number) => {
    if (stopped || params.isClosing()) {
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      if (stopped || params.isClosing()) {
        return;
      }
      if (params.isBusy()) {
        schedule(params.retryDelayMs);
        return;
      }
      // Publish the join handle before child code can re-enter gateway shutdown.
      const task = Promise.resolve().then(() =>
        runWithGatewayIndependentRootWorkAdmission(async () => {
          if (stopped || params.isClosing()) {
            return;
          }
          // Recheck inside admission so work that arrived while this task was
          // joining the root set gets priority over non-urgent maintenance.
          if (params.isBusy()) {
            schedule(params.retryDelayMs);
            return;
          }
          await params.run();
        }),
      );
      const settled = task
        .catch((error: unknown) => params.log.warn(`${params.errorMessage}: ${String(error)}`))
        .finally(() => {
          if (inFlight === settled) {
            inFlight = null;
          }
        });
      inFlight = settled;
    }, delayMs);
    timer.unref?.();
  };
  schedule(params.delayMs);
  return {
    stop: () => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      stopPromise ??= inFlight ?? Promise.resolve();
      return stopPromise;
    },
  };
}
