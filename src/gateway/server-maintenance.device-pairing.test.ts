import { afterEach, describe, expect, it, vi } from "vitest";
import { createGatewayMaintenanceStateForTest } from "./test-helpers.maintenance-state.js";

describe("device pairing maintenance", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("prunes retained setup outcomes at startup and every maintenance minute", async () => {
    vi.useFakeTimers();
    const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");
    const runDevicePairSetupCompletionGc = vi.fn(async () => undefined);
    const timers = startGatewayMaintenanceTimers({
      ...createGatewayMaintenanceStateForTest(),
      logHealth: { info: vi.fn(), error: vi.fn() },
      runWorktreeGc: vi.fn(async () => undefined),
      runDeliveryQueueMediaGc: vi.fn(async () => undefined),
      runDevicePairSetupCompletionGc,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(runDevicePairSetupCompletionGc).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runDevicePairSetupCompletionGc).toHaveBeenCalledTimes(2);

    clearInterval(timers.tickInterval);
    clearInterval(timers.healthInterval);
    clearInterval(timers.dedupeCleanup);
    clearInterval(timers.worktreeCleanup);
    await timers.stopMediaCleanup();
    timers.skillCuratorCleanup();
  });
});
