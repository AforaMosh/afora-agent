// Whatsapp tests cover auto-reply shutdown and reconnect lifecycle behavior.
import "./test-helpers.js";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  createMockWebListener,
  createScriptedWebListenerFactory,
  createWebListenerFactoryCapture,
  getLastWebAutoReplySessionSocket,
  installWebAutoReplyTestHomeHooks,
  installWebAutoReplyUnitTestHooks,
  startWebAutoReplyMonitor,
} from "./auto-reply.test-harness.js";

vi.mock("openclaw/plugin-sdk/delivery-queue-runtime", () => ({
  drainPendingDeliveries: vi.fn(async (_opts: unknown) => undefined),
}));

installWebAutoReplyTestHomeHooks();

type ProcessSignalListener = ReturnType<typeof process.rawListeners>[number];

function findAddedSigintListeners(existingListeners: ReadonlySet<ProcessSignalListener>) {
  return process.rawListeners("SIGINT").filter((listener) => !existingListeners.has(listener));
}

function createAbortableReconnectSleep() {
  let rejectPendingSleep: ((reason?: unknown) => void) | undefined;
  const sleep = vi.fn(
    (_delayMs: number, signal?: AbortSignal) =>
      new Promise<void>((_resolve, reject) => {
        rejectPendingSleep = reject;
        signal?.addEventListener("abort", () => reject(new Error("reconnect sleep aborted")), {
          once: true,
        });
      }),
  );
  return {
    sleep,
    cancelPendingSleep: () => rejectPendingSleep?.(new Error("test cleanup")),
  };
}

async function waitForScriptedListener(
  scripted: ReturnType<typeof createScriptedWebListenerFactory>,
) {
  await vi.waitFor(() => expect(scripted.getListenerCount()).toBe(1), {
    timeout: 250,
    interval: 2,
  });
}

describe("web auto-reply shutdown lifecycle", () => {
  installWebAutoReplyUnitTestHooks();

  let monitorWebChannel: typeof import("./auto-reply/monitor.js").monitorWebChannel;
  beforeAll(async () => {
    ({ monitorWebChannel } = await import("./auto-reply/monitor.js"));
  });

  it("handles reconnect progress and max-attempt stop behavior", async () => {
    for (const scenario of [
      {
        reconnect: { initialMs: 10, maxMs: 10, maxAttempts: 3, factor: 1.1 },
        expectedCallsAfterFirstClose: 2,
        closeTwiceAndFinish: false,
        expectedError: "Retry 1",
      },
      {
        reconnect: { initialMs: 5, maxMs: 5, maxAttempts: 2, factor: 1.1 },
        expectedCallsAfterFirstClose: 2,
        closeTwiceAndFinish: true,
        expectedError: "max attempts reached",
      },
    ]) {
      const sleep = vi.fn(async () => {});
      const scripted = createScriptedWebListenerFactory();
      const { runtime, controller, run } = startWebAutoReplyMonitor({
        monitorWebChannelFn: monitorWebChannel as never,
        listenerFactory: scripted.listenerFactory,
        sleep,
        reconnect: scenario.reconnect,
      });

      await vi.waitFor(
        () => {
          expect(scripted.getListenerCount()).toBe(1);
        },
        { timeout: 250, interval: 2 },
      );

      scripted.resolveClose(0);
      await vi.waitFor(
        () => {
          expect(scripted.getListenerCount()).toBe(scenario.expectedCallsAfterFirstClose);
        },
        { timeout: 250, interval: 2 },
      );

      if (scenario.closeTwiceAndFinish) {
        scripted.resolveClose(1);
        await run;
      } else {
        controller.abort();
        scripted.resolveClose(1);
        await Promise.resolve();
        await run;
      }

      expect(
        runtime.error.mock.calls.some(([message]) =>
          String(message instanceof Error ? message.message : message).includes(
            scenario.expectedError,
          ),
        ),
      ).toBe(true);
    }
  });

  it("stops an active standalone WhatsApp socket when its SIGINT handler runs", async () => {
    const existingSigintListeners = new Set(process.rawListeners("SIGINT"));
    const scripted = createScriptedWebListenerFactory();
    const run = monitorWebChannel(
      false,
      scripted.listenerFactory as never,
      true,
      async () => undefined,
    );

    try {
      await waitForScriptedListener(scripted);
      const sigintListeners = findAddedSigintListeners(existingSigintListeners);
      expect(sigintListeners).toHaveLength(1);

      const socket = getLastWebAutoReplySessionSocket();
      expect(socket.end).not.toHaveBeenCalled();
      sigintListeners[0]?.("SIGINT");

      await vi.waitFor(() => expect(socket.end).toHaveBeenCalledOnce(), {
        timeout: 250,
        interval: 2,
      });
      await expect(run).resolves.toBeUndefined();
      expect(scripted.listeners[0]?.close).toHaveBeenCalledOnce();
      expect(findAddedSigintListeners(existingSigintListeners)).toEqual([]);
    } finally {
      for (const listener of findAddedSigintListeners(existingSigintListeners)) {
        listener("SIGINT");
      }
      scripted.resolveClose(0, { status: 499, isLoggedOut: false, error: "test cleanup" });
      await run.catch(() => {});
    }
  });

  it.each([
    { owner: "standalone SIGINT", stage: "initial", gatewayManaged: false, reconnecting: false },
    { owner: "standalone SIGINT", stage: "reconnect", gatewayManaged: false, reconnecting: true },
    { owner: "Gateway abort", stage: "initial", gatewayManaged: true, reconnecting: false },
    { owner: "Gateway abort", stage: "reconnect", gatewayManaged: true, reconnecting: true },
  ])(
    "stops $owner cleanly during $stage listener setup",
    async ({ gatewayManaged, reconnecting }) => {
      const existingSigintListeners = new Set(process.rawListeners("SIGINT"));
      const gatewayController = gatewayManaged ? new AbortController() : undefined;
      const lateListener = createMockWebListener();
      let finishPendingSetup: ((listener: typeof lateListener) => void) | undefined;
      const pendingSetup = new Promise<typeof lateListener>((resolve) => {
        finishPendingSetup = resolve;
      });
      let finishInitialConnection: ((reason: unknown) => void) | undefined;
      const initialListener = {
        ...createMockWebListener(),
        onClose: new Promise<unknown>((resolve) => {
          finishInitialConnection = resolve;
        }),
      };
      let listenerCalls = 0;
      const listenerFactory = vi.fn(async () => {
        listenerCalls += 1;
        return reconnecting && listenerCalls === 1 ? initialListener : await pendingSetup;
      });
      const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
      const run = monitorWebChannel(
        false,
        listenerFactory as never,
        true,
        async () => undefined,
        runtime as never,
        gatewayController?.signal,
        { sleep: vi.fn(async () => {}) },
      );

      try {
        await vi.waitFor(() => expect(listenerFactory).toHaveBeenCalledOnce());
        if (reconnecting) {
          finishInitialConnection?.({ status: 408, isLoggedOut: false, error: "connection lost" });
          await vi.waitFor(() => expect(listenerFactory).toHaveBeenCalledTimes(2));
        }

        const socket = getLastWebAutoReplySessionSocket();
        const sigintListeners = findAddedSigintListeners(existingSigintListeners);
        if (gatewayController) {
          expect(sigintListeners).toEqual([]);
          gatewayController.abort();
        } else {
          expect(sigintListeners).toHaveLength(1);
          sigintListeners[0]?.("SIGINT");
        }

        await expect(run).resolves.toBeUndefined();
        expect(socket.end).toHaveBeenCalledOnce();
        expect(findAddedSigintListeners(existingSigintListeners)).toEqual([]);

        finishPendingSetup?.(lateListener);
        await vi.waitFor(() => expect(lateListener.close).toHaveBeenCalledOnce());
      } finally {
        gatewayController?.abort();
        for (const listener of findAddedSigintListeners(existingSigintListeners)) {
          listener("SIGINT");
        }
        finishInitialConnection?.({ status: 499, isLoggedOut: false, error: "test cleanup" });
        finishPendingSetup?.(lateListener);
        await run.catch(() => {});
      }
    },
  );

  it("cancels standalone WhatsApp reconnect sleep on SIGINT without opening another socket", async () => {
    const existingSigintListeners = new Set(process.rawListeners("SIGINT"));
    const scripted = createScriptedWebListenerFactory();
    const reconnectSleep = createAbortableReconnectSleep();
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    const run = monitorWebChannel(
      false,
      scripted.listenerFactory as never,
      true,
      async () => undefined,
      runtime as never,
      undefined,
      { sleep: reconnectSleep.sleep },
    );

    try {
      await waitForScriptedListener(scripted);
      const sigintListeners = findAddedSigintListeners(existingSigintListeners);
      expect(sigintListeners).toHaveLength(1);

      scripted.resolveClose(0, { status: 408, isLoggedOut: false, error: "connection lost" });
      await vi.waitFor(() => expect(reconnectSleep.sleep).toHaveBeenCalledOnce());

      const reconnectSignal = reconnectSleep.sleep.mock.calls[0]?.[1];
      expect(reconnectSignal).toBeInstanceOf(AbortSignal);
      sigintListeners[0]?.("SIGINT");
      expect(reconnectSignal?.aborted).toBe(true);

      await expect(run).resolves.toBeUndefined();
      expect(scripted.getListenerCount()).toBe(1);
      expect(findAddedSigintListeners(existingSigintListeners)).toEqual([]);
    } finally {
      for (const listener of findAddedSigintListeners(existingSigintListeners)) {
        listener("SIGINT");
      }
      reconnectSleep.cancelPendingSleep();
      scripted.resolveClose(0, { status: 499, isLoggedOut: false, error: "test cleanup" });
      await run.catch(() => {});
    }
  });

  it("keeps Gateway cancellation on its original signal without adding a process listener", async () => {
    const existingSigintListeners = new Set(process.rawListeners("SIGINT"));
    const originalMaxListeners = process.getMaxListeners();
    const gatewayController = new AbortController();
    const scripted = createScriptedWebListenerFactory();
    const reconnectSleep = createAbortableReconnectSleep();
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    const run = monitorWebChannel(
      false,
      scripted.listenerFactory as never,
      true,
      async () => undefined,
      runtime as never,
      gatewayController.signal,
      { sleep: reconnectSleep.sleep },
    );

    try {
      await waitForScriptedListener(scripted);
      expect(findAddedSigintListeners(existingSigintListeners)).toEqual([]);
      expect(process.getMaxListeners()).toBe(originalMaxListeners);

      scripted.resolveClose(0, { status: 408, isLoggedOut: false, error: "connection lost" });
      await vi.waitFor(() => expect(reconnectSleep.sleep).toHaveBeenCalledOnce());
      expect(reconnectSleep.sleep.mock.calls[0]?.[1]).toBe(gatewayController.signal);

      gatewayController.abort();
      await expect(run).resolves.toBeUndefined();
      expect(scripted.getListenerCount()).toBe(1);
      expect(findAddedSigintListeners(existingSigintListeners)).toEqual([]);
    } finally {
      gatewayController.abort();
      reconnectSleep.cancelPendingSleep();
      scripted.resolveClose(0, { status: 499, isLoggedOut: false, error: "test cleanup" });
      await run.catch(() => {});
    }
  });

  it("preserves the process listener budget after standalone monitoring completes", async () => {
    const existingSigintListeners = new Set(process.rawListeners("SIGINT"));
    const originalMaxListeners = process.getMaxListeners();
    const capture = createWebListenerFactoryCapture();

    await monitorWebChannel(false, capture.listenerFactory as never, false, async () => undefined);

    expect(process.getMaxListeners()).toBe(originalMaxListeners);
    expect(findAddedSigintListeners(existingSigintListeners)).toEqual([]);
  });

  it("removes its standalone SIGINT listener when opening the WhatsApp socket fails", async () => {
    const existingSigintListeners = new Set(process.rawListeners("SIGINT"));
    const listenerFactory = vi.fn(async () => {
      throw new Error("WhatsApp listener setup failed");
    });

    await expect(
      monitorWebChannel(false, listenerFactory as never, true, async () => undefined),
    ).rejects.toThrow("WhatsApp listener setup failed");

    expect(findAddedSigintListeners(existingSigintListeners)).toEqual([]);
  });
});
