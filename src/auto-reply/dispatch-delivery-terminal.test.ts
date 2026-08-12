import { describe, expect, it } from "vitest";
import { PlatformMessageNotDispatchedError } from "../infra/outbound/deliver-types.js";
import { finalizeDispatchResult } from "./dispatch-delivery-terminal.js";
import { createReplyDispatcher } from "./reply/reply-dispatcher.js";

describe("dispatch delivery terminal", () => {
  it("returns a redacted failed terminal for a permanent provider rejection", async () => {
    const dispatcher = createReplyDispatcher({
      deliver: async () => {
        throw new PlatformMessageNotDispatchedError("provider rejected message", {
          cause: new Error("secret provider response"),
          retryable: false,
          publicError: { code: "230099" },
        });
      },
    });
    dispatcher.sendFinalReply({ text: "the final answer" });
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    const result = finalizeDispatchResult(
      { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } },
      dispatcher,
    );

    expect(result).toMatchObject({
      queuedFinal: false,
      counts: { final: 0 },
      failedCounts: { final: 1 },
      deliveryTerminal: {
        outcome: "failed",
        retryable: false,
        error: { code: "230099" },
      },
    });
    expect(JSON.stringify(result)).not.toContain("secret provider response");
  });

  it("aggregates failed finals independently of dispatch order", async () => {
    for (const order of [
      ["rejected", "ambiguous"],
      ["ambiguous", "rejected"],
    ]) {
      const dispatcher = createReplyDispatcher({
        deliver: async (payload) => {
          if (payload.text === "rejected") {
            throw new PlatformMessageNotDispatchedError("provider rejected message", {
              cause: new Error("provider rejected message"),
              retryable: false,
              publicError: { code: "230099" },
            });
          }
          throw new Error("provider outcome unknown");
        },
      });
      for (const text of order) {
        dispatcher.sendFinalReply({ text });
      }
      dispatcher.markComplete();
      await dispatcher.waitForIdle();

      expect(
        finalizeDispatchResult(
          { queuedFinal: true, counts: { tool: 0, block: 0, final: 2 } },
          dispatcher,
        ),
      ).toMatchObject({
        queuedFinal: false,
        counts: { final: 0 },
        failedCounts: { final: 2 },
        deliveryTerminal: { outcome: "unknown", retryable: false },
      });
    }
  });

  it("keeps a single mixed streaming and fallback failure graph unknown", async () => {
    const dispatcher = createReplyDispatcher({
      deliver: async () => {
        const rejected = new PlatformMessageNotDispatchedError("streaming rejected", {
          cause: new Error("streaming rejected"),
          retryable: false,
          publicError: { code: "230099" },
        });
        throw new AggregateError([rejected, new Error("static fallback outcome unknown")]);
      },
    });
    dispatcher.sendFinalReply({ text: "the final answer" });
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    expect(
      finalizeDispatchResult(
        { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } },
        dispatcher,
      ),
    ).toMatchObject({
      queuedFinal: false,
      counts: { final: 0 },
      failedCounts: { final: 1 },
      deliveryTerminal: { outcome: "unknown", retryable: false },
    });
  });

  it("retains a permanent fallback code beside a retryable streaming attempt", async () => {
    const dispatcher = createReplyDispatcher({
      deliver: async () => {
        const retryableStart = new PlatformMessageNotDispatchedError("streaming throttled", {
          cause: new Error("streaming throttled"),
          retryable: true,
          publicError: { code: "230001" },
        });
        const permanentFallback = new PlatformMessageNotDispatchedError("fallback rejected", {
          cause: new Error("fallback rejected"),
          retryable: false,
          publicError: { code: "230099" },
        });
        throw new PlatformMessageNotDispatchedError("fallback rejected", {
          cause: new AggregateError([retryableStart, permanentFallback]),
          retryable: true,
          publicError: { code: "230099" },
        });
      },
    });
    dispatcher.sendFinalReply({ text: "the final answer" });
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    expect(
      finalizeDispatchResult(
        { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } },
        dispatcher,
      ),
    ).toMatchObject({
      queuedFinal: false,
      counts: { final: 0 },
      failedCounts: { final: 1 },
      deliveryTerminal: {
        outcome: "failed",
        retryable: true,
        error: { code: "230099" },
      },
    });
  });
});
