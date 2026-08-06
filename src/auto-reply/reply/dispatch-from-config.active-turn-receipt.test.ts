import { describe, expect, it, vi } from "vitest";
import {
  classifyActiveTurnReceiptDispatchOutcome,
  createActiveTurnReceiptCoordinator,
  type ActiveTurnReceiptDeliveryOutcome,
} from "./dispatch-from-config.active-turn-receipt.js";

const ACTIVE_TURN_RECEIPT_DELAY_MS = 30_000;

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("createActiveTurnReceiptCoordinator", () => {
  it("attempts one receipt after the 30-second bound", async () => {
    vi.useFakeTimers();
    try {
      const deliver = vi.fn(async () => "confirmed-visible" as const);
      const coordinator = createActiveTurnReceiptCoordinator();
      coordinator.arm({ eligible: true, deliver });

      await vi.advanceTimersByTimeAsync(ACTIVE_TURN_RECEIPT_DELAY_MS - 1);
      expect(deliver).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(deliver).toHaveBeenCalledOnce();
      await vi.runAllTimersAsync();
      expect(deliver).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves proven-unsent recovery to the delivery owner and never replays maybe-visible", async () => {
    vi.useFakeTimers();
    try {
      const outcomes: ActiveTurnReceiptDeliveryOutcome[] = ["proven-unsent", "confirmed-visible"];
      const retryDeliver = vi.fn(async () => outcomes.shift() ?? "maybe-visible");
      const retryCoordinator = createActiveTurnReceiptCoordinator();
      retryCoordinator.arm({ eligible: true, deliver: retryDeliver });
      await vi.advanceTimersByTimeAsync(ACTIVE_TURN_RECEIPT_DELAY_MS);
      expect(retryDeliver).toHaveBeenCalledOnce();

      const ambiguousDeliver = vi.fn(async () => "maybe-visible" as const);
      const ambiguousCoordinator = createActiveTurnReceiptCoordinator();
      ambiguousCoordinator.arm({ eligible: true, deliver: ambiguousDeliver });
      await vi.advanceTimersByTimeAsync(ACTIVE_TURN_RECEIPT_DELAY_MS);
      expect(ambiguousDeliver).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels for established visibility, terminal settlement, and abort", async () => {
    vi.useFakeTimers();
    try {
      const deliver = vi.fn(async () => "confirmed-visible" as const);
      const visibleCoordinator = createActiveTurnReceiptCoordinator();
      visibleCoordinator.arm({ eligible: true, deliver });
      visibleCoordinator.noteVisible();

      const terminalCoordinator = createActiveTurnReceiptCoordinator();
      terminalCoordinator.arm({ eligible: true, deliver });
      await terminalCoordinator.settleBeforeTerminal();

      const abortController = new AbortController();
      const abortedCoordinator = createActiveTurnReceiptCoordinator();
      abortedCoordinator.arm({
        eligible: true,
        abortSignal: abortController.signal,
        deliver,
      });
      abortController.abort();

      await vi.advanceTimersByTimeAsync(ACTIVE_TURN_RECEIPT_DELAY_MS);
      expect(deliver).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("settles an in-flight receipt before terminal delivery proceeds", async () => {
    vi.useFakeTimers();
    try {
      const receipt = createDeferred<ActiveTurnReceiptDeliveryOutcome>();
      const events: string[] = [];
      const coordinator = createActiveTurnReceiptCoordinator();
      coordinator.arm({
        eligible: true,
        deliver: async () => {
          events.push("receipt-start");
          const outcome = await receipt.promise;
          events.push("receipt-settled");
          return outcome;
        },
      });
      await vi.advanceTimersByTimeAsync(ACTIVE_TURN_RECEIPT_DELAY_MS);
      const terminal = coordinator.settleBeforeTerminal().then(() => {
        events.push("terminal");
      });
      await Promise.resolve();
      expect(events).toEqual(["receipt-start"]);

      receipt.resolve("proven-unsent");
      await terminal;
      expect(events).toEqual(["receipt-start", "receipt-settled", "terminal"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds terminal settlement and aborts a hung receipt", async () => {
    vi.useFakeTimers();
    try {
      let deliverySignal: AbortSignal | undefined;
      const coordinator = createActiveTurnReceiptCoordinator();
      coordinator.arm({
        eligible: true,
        deliver: async (signal) => {
          deliverySignal = signal;
          return await new Promise<ActiveTurnReceiptDeliveryOutcome>(() => {});
        },
      });
      await vi.advanceTimersByTimeAsync(ACTIVE_TURN_RECEIPT_DELAY_MS);
      const terminal = coordinator.settleBeforeTerminal();
      await vi.advanceTimersByTimeAsync(4_999);
      expect(deliverySignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await terminal;
      expect(deliverySignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("classifyActiveTurnReceiptDispatchOutcome", () => {
  it.each([
    ["delivered", "confirmed-visible"],
    ["cancelled", "proven-unsent"],
    ["failed-before-deliver", "proven-unsent"],
    ["failed-deliver", "maybe-visible"],
  ] as const)("classifies %s as %s", (outcome, expected) => {
    expect(classifyActiveTurnReceiptDispatchOutcome(outcome)).toBe(expected);
  });
});
