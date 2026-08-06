import { afterEach, describe, expect, it, vi } from "vitest";
import { scheduleGatewayIdleTask } from "./server-idle-task.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("scheduleGatewayIdleTask", () => {
  it("still completes ordinary idle work", async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => {});
    const handle = scheduleGatewayIdleTask({
      delayMs: 10,
      retryDelayMs: 5,
      isClosing: () => false,
      isBusy: () => false,
      run,
      log: { warn: vi.fn() },
      errorMessage: "idle task failed",
    });

    await vi.advanceTimersByTimeAsync(10);
    await Promise.resolve();
    expect(run).toHaveBeenCalledOnce();
    await handle.stop();
  });

  it("keeps stop pending after the timer fires until child work settles", async () => {
    vi.useFakeTimers();
    let finishRun: (() => void) | undefined;
    const run = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishRun = resolve;
        }),
    );
    const handle = scheduleGatewayIdleTask({
      delayMs: 10,
      retryDelayMs: 5,
      isClosing: () => false,
      isBusy: () => false,
      run,
      log: { warn: vi.fn() },
      errorMessage: "idle task failed",
    });

    await vi.advanceTimersByTimeAsync(10);
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());

    let stopSettled = false;
    const stop = handle.stop().then(() => {
      stopSettled = true;
    });
    await Promise.resolve();
    expect(stopSettled).toBe(false);

    if (!finishRun) {
      throw new Error("Expected idle task resolver to be initialized");
    }
    finishRun();
    await stop;
    expect(stopSettled).toBe(true);
  });
});
