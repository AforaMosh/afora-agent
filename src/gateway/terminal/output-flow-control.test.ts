import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalOutputController } from "./output-flow-control.js";
import { makeFakePty } from "./session-manager.test-helpers.js";

const HIGH_WATER_BYTES = 4 * 1024 * 1024;
const LOW_WATER_BYTES = 512 * 1024;
const RECOVERY_INTERVAL_MS = 5_000;

describe("TerminalOutputController pressure recovery", () => {
  let controllers: TerminalOutputController[];

  beforeEach(() => {
    vi.useFakeTimers();
    controllers = [];
  });

  afterEach(() => {
    for (const controller of controllers) {
      controller.dispose();
    }
    vi.useRealTimers();
  });

  function createHarness(connIds = ["viewer-1"]) {
    const pty = makeFakePty();
    const recipients = new Set(connIds);
    const bufferedAmounts = new Map(connIds.map((connId) => [connId, HIGH_WATER_BYTES]));
    const output = new TerminalOutputController({
      backend: pty,
      getConnIds: () => [...recipients],
      getBufferedAmount: (connId) => bufferedAmounts.get(connId),
      record: vi.fn(),
      emit: vi.fn(),
    });
    controllers.push(output);
    pty.onData((chunk) => output.push(chunk));
    return { bufferedAmounts, output, pty, recipients };
  }

  async function enterPressure(pty: ReturnType<typeof makeFakePty>, chunk = "pressure") {
    pty.emitData(chunk);
    await vi.advanceTimersByTimeAsync(4);
    expect(pty.paused).toBe(true);
    expect(vi.getTimerCount()).toBe(1);
  }

  function failFirstResume(pty: ReturnType<typeof makeFakePty>) {
    const resume = pty.resume;
    let attempts = 0;
    pty.resume = () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("native resume temporarily unavailable");
      }
      resume();
    };
    return () => attempts;
  }

  it("retires the recovery timer after socket pressure drains", async () => {
    const { bufferedAmounts, pty } = createHarness();
    await enterPressure(pty);

    bufferedAmounts.set("viewer-1", 0);
    await vi.advanceTimersByTimeAsync(RECOVERY_INTERVAL_MS);

    expect(pty.paused).toBe(false);
    expect(pty.resumeCalls).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(3 * RECOVERY_INTERVAL_MS);
    expect(pty.resumeCalls).toBe(1);
  });

  it("preserves watermark hysteresis until pressure reaches the low boundary", async () => {
    const { bufferedAmounts, pty } = createHarness();
    await enterPressure(pty);

    bufferedAmounts.set("viewer-1", LOW_WATER_BYTES + 1);
    await vi.advanceTimersByTimeAsync(RECOVERY_INTERVAL_MS);
    expect(pty.paused).toBe(true);
    expect(pty.resumeCalls).toBe(0);
    expect(vi.getTimerCount()).toBe(1);

    bufferedAmounts.set("viewer-1", LOW_WATER_BYTES);
    await vi.advanceTimersByTimeAsync(RECOVERY_INTERVAL_MS);
    expect(pty.paused).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retries a failed native resume before retiring its recovery timer", async () => {
    const { bufferedAmounts, pty } = createHarness();
    const resumeAttempts = failFirstResume(pty);
    await enterPressure(pty);

    bufferedAmounts.set("viewer-1", 0);
    await vi.advanceTimersByTimeAsync(RECOVERY_INTERVAL_MS);
    expect(resumeAttempts()).toBe(1);
    expect(pty.paused).toBe(true);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(RECOVERY_INTERVAL_MS);
    expect(resumeAttempts()).toBe(2);
    expect(pty.paused).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("owns one recovery timer per episode and rearms later congestion", async () => {
    const { bufferedAmounts, pty } = createHarness();

    for (const chunk of ["first congestion", "second congestion"]) {
      bufferedAmounts.set("viewer-1", HIGH_WATER_BYTES);
      await enterPressure(pty, chunk);
      await vi.advanceTimersByTimeAsync(RECOVERY_INTERVAL_MS);
      expect(pty.paused).toBe(true);
      expect(vi.getTimerCount()).toBe(1);

      bufferedAmounts.set("viewer-1", 0);
      await vi.advanceTimersByTimeAsync(RECOVERY_INTERVAL_MS);
      expect(pty.paused).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    }

    expect(pty.resumeCalls).toBe(2);
  });

  it("retires recovery when the last viewer releases terminal ownership", async () => {
    const { output, pty, recipients } = createHarness();
    await enterPressure(pty);

    recipients.clear();
    output.resetOwnership();

    expect(pty.paused).toBe(false);
    expect(pty.resumeCalls).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(2 * RECOVERY_INTERVAL_MS);
    expect(pty.resumeCalls).toBe(1);
  });

  it("retries a failed native resume after the last viewer leaves", async () => {
    const { output, pty, recipients } = createHarness();
    const resumeAttempts = failFirstResume(pty);
    await enterPressure(pty);

    recipients.clear();
    output.resetOwnership();
    expect(resumeAttempts()).toBe(1);
    expect(pty.paused).toBe(true);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(RECOVERY_INTERVAL_MS);
    expect(resumeAttempts()).toBe(2);
    expect(pty.paused).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retires recovery when a congested viewer leaves a healthy co-viewer", async () => {
    const { bufferedAmounts, output, pty, recipients } = createHarness([
      "viewer-slow",
      "viewer-healthy",
    ]);
    bufferedAmounts.set("viewer-healthy", 0);
    await enterPressure(pty);

    recipients.delete("viewer-slow");
    output.reconcileRecipients();

    expect(pty.paused).toBe(false);
    expect(pty.resumeCalls).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops the recovery timer when its terminal owner is disposed", async () => {
    const { output, pty } = createHarness();
    await enterPressure(pty);

    output.dispose();

    expect(pty.paused).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
