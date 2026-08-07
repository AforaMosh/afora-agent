// Tests before-deliver hook ordering and payload mutation behavior.
import { describe, expect, it, vi } from "vitest";
import { getReplyPayloadMetadata, setReplyPayloadMetadata } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import {
  bindActiveTurnReceiptSignals,
  claimActiveTurnReceiptTransport,
} from "./active-turn-receipt-signals.js";
import {
  appendReplyDispatcherBeforeDeliverCancelled,
  attachReplyDispatchUndeliveredFallback,
  captureReplyDispatchDeliveryOutcome,
  createReplyDispatcher,
} from "./reply-dispatcher.js";

describe("beforeDeliver in reply dispatcher", () => {
  it("delivers the attached fallback when the primary payload is cancelled", async () => {
    const delivered: string[] = [];
    const primary: ReplyPayload = { text: "caption", mediaUrl: "/tmp/voice.ogg" };
    attachReplyDispatchUndeliveredFallback(primary, { text: "caption" });
    const outcome = captureReplyDispatchDeliveryOutcome(primary);
    const dispatcher = createReplyDispatcher({
      beforeDeliver: (payload) => (payload.mediaUrl ? null : payload),
      deliver: async (payload) => {
        delivered.push(payload.text ?? "");
      },
    });

    expect(dispatcher.sendFinalReply(primary)).toBe(true);
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    expect(delivered).toEqual(["caption"]);
    await expect(outcome.promise).resolves.toBe("delivered");
    expect(dispatcher.getCancelledCounts?.().final).toBe(0);
  });

  it("delivers the fallback when primary normalization is cancelled", async () => {
    const delivered: ReplyPayload[] = [];
    const primary: ReplyPayload = { text: "caption", mediaUrl: "/tmp/voice.ogg" };
    attachReplyDispatchUndeliveredFallback(primary, { text: "caption" });
    const dispatcher = createReplyDispatcher({
      transformReplyPayload: (payload) => (payload.mediaUrl ? null : payload),
      deliver: async (payload) => {
        delivered.push(payload);
      },
    });

    expect(dispatcher.sendFinalReply(primary)).toBe(true);
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    expect(delivered).toEqual([{ text: "caption" }]);
  });

  it("delivers the attached fallback after a proven pre-transport failure", async () => {
    const delivered: string[] = [];
    const primary: ReplyPayload = { text: "caption", mediaUrl: "/tmp/voice.ogg" };
    attachReplyDispatchUndeliveredFallback(primary, { text: "caption" });
    const dispatcher = createReplyDispatcher({
      deliver: async (payload) => {
        if (payload.mediaUrl) {
          throw Object.assign(new Error("connect failed"), {
            code: "ECONNREFUSED",
            syscall: "connect",
          });
        }
        delivered.push(payload.text ?? "");
      },
    });

    dispatcher.sendFinalReply(primary);
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    expect(delivered).toEqual(["caption"]);
    expect(dispatcher.getFailedCounts().final).toBe(0);
  });

  it("does not duplicate text after an ambiguous transport failure", async () => {
    const delivered: string[] = [];
    const primary: ReplyPayload = { text: "caption", mediaUrl: "/tmp/voice.ogg" };
    attachReplyDispatchUndeliveredFallback(primary, { text: "caption" });
    const dispatcher = createReplyDispatcher({
      deliver: async (payload) => {
        delivered.push(payload.text ?? "");
        throw new Error("send outcome unknown");
      },
    });

    dispatcher.sendFinalReply(primary);
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    expect(delivered).toEqual(["caption"]);
    expect(dispatcher.getFailedCounts().final).toBe(1);
  });

  it("classifies active receipt aborts around the transport boundary", async () => {
    let releaseHook: (() => void) | undefined;
    const hookPending = new Promise<void>((resolve) => {
      releaseHook = resolve;
    });
    const beforeTransportAbort = new AbortController();
    const beforeTransportTerminalAbort = new AbortController();
    const beforeTransportPayload = setReplyPayloadMetadata(
      { text: "receipt before transport" },
      {
        activeTurnReceipt: {
          abortSignal: bindActiveTurnReceiptSignals({
            preTransport: beforeTransportAbort.signal,
            terminal: beforeTransportTerminalAbort.signal,
          }),
          maxRetries: 1,
        },
      },
    );
    const beforeTransportOutcome = captureReplyDispatchDeliveryOutcome(beforeTransportPayload);
    const delivered: string[] = [];
    const beforeTransportDispatcher = createReplyDispatcher({
      beforeDeliver: async (payload) => {
        await hookPending;
        return payload;
      },
      deliver: async (payload) => {
        delivered.push(payload.text ?? "");
      },
    });

    beforeTransportDispatcher.sendFinalReply(beforeTransportPayload);
    await Promise.resolve();
    beforeTransportAbort.abort(new Error("receipt deadline"));
    beforeTransportDispatcher.markComplete();
    await beforeTransportDispatcher.waitForIdle();

    await expect(beforeTransportOutcome.promise).resolves.toBe("failed-before-deliver");
    expect(delivered).toEqual([]);

    releaseHook?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(delivered).toEqual([]);

    let transportStarted = false;
    const afterTransportAbort = new AbortController();
    const afterTransportTerminalAbort = new AbortController();
    const afterTransportPayload = setReplyPayloadMetadata(
      { text: "receipt after transport" },
      {
        activeTurnReceipt: {
          abortSignal: bindActiveTurnReceiptSignals({
            preTransport: afterTransportAbort.signal,
            terminal: afterTransportTerminalAbort.signal,
          }),
          maxRetries: 1,
        },
      },
    );
    const afterTransportOutcome = captureReplyDispatchDeliveryOutcome(afterTransportPayload);
    const afterTransportDispatcher = createReplyDispatcher({
      deliver: async () => {
        claimActiveTurnReceiptTransport(afterTransportTerminalAbort.signal);
        transportStarted = true;
        await new Promise<void>(() => {});
      },
    });

    afterTransportDispatcher.sendFinalReply(afterTransportPayload);
    await Promise.resolve();
    expect(transportStarted).toBe(true);
    afterTransportAbort.abort(new Error("receipt deadline"));
    let transportOutcomeSettled = false;
    void afterTransportOutcome.promise.then(() => {
      transportOutcomeSettled = true;
    });
    await Promise.resolve();
    expect(transportOutcomeSettled).toBe(false);
    afterTransportTerminalAbort.abort(new Error("receipt terminal deadline"));
    afterTransportDispatcher.markComplete();
    await afterTransportDispatcher.waitForIdle();

    await expect(afterTransportOutcome.promise).resolves.toBe("failed-deliver");
  });

  it("cancels receipt delivery while channel payload preparation is still blocked", async () => {
    const preTransport = new AbortController();
    const terminal = new AbortController();
    const payload = setReplyPayloadMetadata(
      { text: "receipt during preparation" },
      {
        activeTurnReceipt: {
          abortSignal: bindActiveTurnReceiptSignals({
            preTransport: preTransport.signal,
            terminal: terminal.signal,
          }),
          maxRetries: 1,
        },
      },
    );
    const outcome = captureReplyDispatchDeliveryOutcome(payload);
    const onError = vi.fn();
    let preparationStarted = false;
    let releasePreparation: (() => void) | undefined;
    const preparation = new Promise<void>((resolve) => {
      releasePreparation = resolve;
    });
    const delivered: string[] = [];
    const dispatcher = createReplyDispatcher({
      onError,
      deliver: async () => {
        preparationStarted = true;
        await preparation;
        claimActiveTurnReceiptTransport(terminal.signal);
        delivered.push("receipt during preparation");
      },
    });

    dispatcher.sendFinalReply(payload);
    await Promise.resolve();
    expect(preparationStarted).toBe(true);
    preTransport.abort(new Error("visible progress arrived during preparation"));
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    await expect(outcome.promise).resolves.toBe("failed-before-deliver");
    expect(terminal.signal.aborted).toBe(false);
    releasePreparation?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(delivered).toEqual([]);
    expect(onError).not.toHaveBeenCalled();
    terminal.abort(new Error("terminal cleanup after late preparation settled"));
  });

  it("classifies a terminal abort in the same turn as the transport claim", async () => {
    const preTransport = new AbortController();
    const terminal = new AbortController();
    const payload = setReplyPayloadMetadata(
      { text: "claimed receipt" },
      {
        activeTurnReceipt: {
          abortSignal: bindActiveTurnReceiptSignals({
            preTransport: preTransport.signal,
            terminal: terminal.signal,
          }),
          maxRetries: 1,
        },
      },
    );
    const outcome = captureReplyDispatchDeliveryOutcome(payload);
    const dispatcher = createReplyDispatcher({
      deliver: async () => {
        claimActiveTurnReceiptTransport(terminal.signal);
        terminal.abort(new Error("terminal containment"));
        await new Promise<void>(() => {});
      },
    });

    dispatcher.sendFinalReply(payload);
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    await expect(outcome.promise).resolves.toBe("failed-deliver");
  });

  it("does not resume later beforeDeliver stages after an aborted stage settles late", async () => {
    let releaseFirstStage: (() => void) | undefined;
    const firstStagePending = new Promise<void>((resolve) => {
      releaseFirstStage = resolve;
    });
    const abort = new AbortController();
    const terminalAbort = new AbortController();
    const payload = setReplyPayloadMetadata(
      { text: "receipt" },
      {
        activeTurnReceipt: {
          abortSignal: bindActiveTurnReceiptSignals({
            preTransport: abort.signal,
            terminal: terminalAbort.signal,
          }),
          maxRetries: 1,
        },
      },
    );
    const outcome = captureReplyDispatchDeliveryOutcome(payload);
    let secondStageCalls = 0;
    let deliveryCalls = 0;
    const dispatcher = createReplyDispatcher({
      beforeDeliver: async (current) => {
        await firstStagePending;
        return current;
      },
      deliver: async () => {
        deliveryCalls += 1;
      },
    });
    dispatcher.appendBeforeDeliver?.((current) => {
      secondStageCalls += 1;
      return current;
    });

    dispatcher.sendFinalReply(payload);
    await Promise.resolve();
    abort.abort(new Error("receipt deadline"));
    dispatcher.markComplete();
    await dispatcher.waitForIdle();
    await expect(outcome.promise).resolves.toBe("failed-before-deliver");

    releaseFirstStage?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(secondStageCalls).toBe(0);
    expect(deliveryCalls).toBe(0);
  });

  it("skips channel error observers for internal receipt cancellation", async () => {
    const abort = new AbortController();
    const terminalAbort = new AbortController();
    const receipt = setReplyPayloadMetadata(
      { text: "receipt" },
      {
        activeTurnReceipt: {
          abortSignal: bindActiveTurnReceiptSignals({
            preTransport: abort.signal,
            terminal: terminalAbort.signal,
          }),
          maxRetries: 1,
        },
      },
    );
    const outcome = captureReplyDispatchDeliveryOutcome(receipt);
    let onErrorCalls = 0;
    const delivered: string[] = [];
    const dispatcher = createReplyDispatcher({
      beforeDeliver: async (payload) => {
        if (payload.text === "receipt") {
          await new Promise<void>(() => {});
        }
        return payload;
      },
      deliver: async (payload) => {
        delivered.push(payload.text ?? "");
      },
      onError: () => {
        onErrorCalls += 1;
        throw new Error("observer failed synchronously");
      },
    });

    dispatcher.sendFinalReply(receipt);
    await Promise.resolve();
    abort.abort(new Error("receipt deadline"));
    dispatcher.sendFinalReply({ text: "final" });
    dispatcher.markComplete();
    await expect(dispatcher.waitForIdle()).resolves.toBeUndefined();
    await expect(outcome.promise).resolves.toBe("failed-before-deliver");
    await Promise.resolve();

    expect(onErrorCalls).toBe(0);
    expect(delivered).toEqual(["final"]);
  });

  it("cancels delivery before queueing when transformReplyPayload returns null", async () => {
    const delivered: string[] = [];

    const dispatcher = createReplyDispatcher({
      deliver: async (payload) => {
        delivered.push(payload.text ?? "");
      },
      transformReplyPayload: (payload: ReplyPayload) => {
        if (payload.text?.includes("blocked")) {
          return null;
        }
        return payload;
      },
    });

    expect(dispatcher.sendFinalReply({ text: "blocked reply" })).toBe(false);
    expect(dispatcher.sendFinalReply({ text: "safe reply" })).toBe(true);
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    expect(delivered).toEqual(["safe reply"]);
    expect(dispatcher.getQueuedCounts()).toEqual({ tool: 0, block: 0, final: 1 });
    expect(dispatcher.getCancelledCounts?.()).toEqual({ tool: 0, block: 0, final: 0 });
  });

  it("cancels delivery when beforeDeliver returns null", async () => {
    const delivered: string[] = [];
    const cancelled: string[] = [];

    const dispatcher = createReplyDispatcher({
      deliver: async (payload) => {
        delivered.push(payload.text ?? "");
      },
      onBeforeDeliverCancelled: (payload) => {
        cancelled.push(payload.text ?? "");
      },
      beforeDeliver: async (payload: ReplyPayload) => {
        if (payload.text?.includes("blocked")) {
          return null;
        }
        return payload;
      },
    });

    dispatcher.sendFinalReply({ text: "blocked reply" });
    dispatcher.sendFinalReply({ text: "safe reply" });
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    expect(delivered).toEqual(["safe reply"]);
    expect(cancelled).toEqual(["blocked reply"]);
    expect(dispatcher.getQueuedCounts()).toEqual({ tool: 0, block: 0, final: 2 });
    expect(dispatcher.getCancelledCounts?.()).toEqual({ tool: 0, block: 0, final: 1 });
  });

  it("notifies appended cancellation observers when beforeDeliver returns null", async () => {
    const delivered: string[] = [];
    const cancelled: string[] = [];
    const errors: string[] = [];

    const dispatcher = createReplyDispatcher({
      deliver: async (payload) => {
        delivered.push(payload.text ?? "");
      },
      beforeDeliver: () => null,
      onBeforeDeliverCancelled: (payload) => {
        cancelled.push(`constructed:${payload.text ?? ""}`);
      },
      onError: (err) => {
        errors.push(err instanceof Error ? err.message : String(err));
      },
    });
    appendReplyDispatcherBeforeDeliverCancelled(dispatcher, (payload) => {
      cancelled.push(`appended-a:${payload.text ?? ""}`);
    });
    appendReplyDispatcherBeforeDeliverCancelled(dispatcher, () => {
      throw new Error("observer failed");
    });
    appendReplyDispatcherBeforeDeliverCancelled(dispatcher, (payload) => {
      cancelled.push(`appended-b:${payload.text ?? ""}`);
    });

    dispatcher.sendFinalReply({ text: "blocked reply" });
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    expect(delivered).toEqual([]);
    expect(cancelled).toEqual([
      "constructed:blocked reply",
      "appended-a:blocked reply",
      "appended-b:blocked reply",
    ]);
    expect(errors).toEqual(["observer failed"]);
    expect(dispatcher.getQueuedCounts()).toEqual({ tool: 0, block: 0, final: 1 });
    expect(dispatcher.getCancelledCounts?.()).toEqual({ tool: 0, block: 0, final: 1 });
    expect(dispatcher.getFailedCounts?.()).toEqual({ tool: 0, block: 0, final: 0 });
  });

  it("notifies cancellation when beforeDeliver throws before delivery", async () => {
    const delivered: string[] = [];
    const cancelled: Array<{
      assistantMessageIndex?: number;
      kind: string;
      text: string;
    }> = [];
    const errors: Array<{
      assistantMessageIndex?: number;
      kind: string;
      message: string;
    }> = [];

    const dispatcher = createReplyDispatcher({
      deliver: async (payload) => {
        delivered.push(payload.text ?? "");
      },
      onBeforeDeliverCancelled: (payload, info) => {
        cancelled.push({
          assistantMessageIndex: info.assistantMessageIndex,
          kind: info.kind,
          text: payload.text ?? "",
        });
      },
      onError: (err, info) => {
        errors.push({
          assistantMessageIndex: info.assistantMessageIndex,
          kind: info.kind,
          message: err instanceof Error ? err.message : String(err),
        });
      },
      beforeDeliver: async () => {
        throw new Error("pre-delivery failed");
      },
    });

    dispatcher.sendBlockReply(
      setReplyPayloadMetadata({ text: "blocked block" }, { assistantMessageIndex: 9 }),
    );
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    expect(delivered).toEqual([]);
    expect(cancelled).toEqual([{ assistantMessageIndex: 9, kind: "block", text: "blocked block" }]);
    expect(errors).toEqual([
      { assistantMessageIndex: 9, kind: "block", message: "pre-delivery failed" },
    ]);
    expect(dispatcher.getQueuedCounts()).toEqual({ tool: 0, block: 1, final: 0 });
    expect(dispatcher.getCancelledCounts?.()).toEqual({ tool: 0, block: 0, final: 0 });
    expect(dispatcher.getFailedCounts?.()).toEqual({ tool: 0, block: 1, final: 0 });
  });

  it("allows modifying payload in beforeDeliver", async () => {
    const delivered: string[] = [];

    const dispatcher = createReplyDispatcher({
      deliver: async (payload) => {
        delivered.push(payload.text ?? "");
      },
      beforeDeliver: async (payload: ReplyPayload) => {
        if (payload.text?.includes("error")) {
          return { ...payload, text: "replaced" };
        }
        return payload;
      },
    });

    dispatcher.sendFinalReply({ text: "some error occurred" });
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    expect(delivered).toEqual(["replaced"]);
  });

  it("preserves payload metadata through beforeDeliver rewrites", async () => {
    let deliveredMetadata: unknown;
    let deliveredAssistantMessageIndex: unknown;

    const dispatcher = createReplyDispatcher({
      deliver: async (payload, info) => {
        deliveredMetadata = getReplyPayloadMetadata(payload);
        deliveredAssistantMessageIndex = info.assistantMessageIndex;
      },
      beforeDeliver: async () => ({ text: "rewritten" }),
    });

    dispatcher.sendBlockReply(
      setReplyPayloadMetadata({ text: "original" }, { assistantMessageIndex: 12 }),
    );
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    expect(deliveredMetadata).toMatchObject({ assistantMessageIndex: 12 });
    expect(deliveredAssistantMessageIndex).toBe(12);
  });

  it("delivers normally without beforeDeliver", async () => {
    const delivered: string[] = [];

    const dispatcher = createReplyDispatcher({
      deliver: async (payload) => {
        delivered.push(payload.text ?? "");
      },
    });

    dispatcher.sendFinalReply({ text: "plain reply" });
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    expect(delivered).toEqual(["plain reply"]);
  });
});
