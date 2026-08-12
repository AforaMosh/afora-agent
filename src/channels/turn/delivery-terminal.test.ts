import { describe, expect, it } from "vitest";
import type { TrustedMessageAuditEvent } from "../../audit/message-audit-events.js";
import { onTrustedMessageAuditEventForTest as onTrustedMessageAuditEvent } from "../../audit/message-audit-events.test-support.js";
import { PlatformMessageNotDispatchedError } from "../../infra/outbound/deliver-types.js";
import { createChannelPartialDeliveryError } from "./delivery-result.js";
import {
  applySettledChannelDeliveryFailures,
  emitChannelDeliveryTerminalObservations,
  resolveChannelDeliveryTerminalFromFailures,
} from "./delivery-terminal.js";

function resolveSingleFailure(error: unknown) {
  return resolveChannelDeliveryTerminalFromFailures({
    deliveredCount: 0,
    failures: [{ error }],
  });
}

describe("channel delivery terminal", () => {
  it("exposes only the provider code for a permanent pre-dispatch rejection", () => {
    const raw = new Error("secret transport detail");
    const error = new PlatformMessageNotDispatchedError("provider rejected message", {
      cause: raw,
      retryable: false,
      publicError: { code: "230099" },
    });

    const terminal = resolveSingleFailure(error);

    expect(terminal).toEqual({
      outcome: "failed",
      retryable: false,
      error: { code: "230099" },
    });
    expect(JSON.stringify(terminal)).not.toContain("secret");
  });

  it("keeps visible partial delivery terminal and non-retryable", () => {
    const error = createChannelPartialDeliveryError(new Error("edit failed"), {
      visibleReplySent: true,
      messageIds: ["om-visible"],
    });

    expect(resolveSingleFailure(error)).toEqual({ outcome: "partial_failure", retryable: false });

    for (const wrapped of [
      new Error("observer wrapper", { cause: error }),
      new AggregateError([new Error("observer failed"), error]),
      new AggregateError([error, new Error("observer failed")]),
    ]) {
      expect(resolveSingleFailure(wrapped)).toEqual({
        outcome: "partial_failure",
        retryable: false,
      });
    }
  });

  it("does not invent a failed disposition for an ambiguous provider error", () => {
    expect(resolveSingleFailure(new Error("socket closed"))).toEqual({
      outcome: "unknown",
      retryable: false,
    });
  });

  it("keeps a mixed proven and ambiguous error graph unknown", () => {
    const rejected = new PlatformMessageNotDispatchedError("streaming rejected", {
      cause: new Error("streaming rejected"),
      retryable: false,
      publicError: { code: "230099" },
    });
    const error = new AggregateError([rejected, new Error("static fallback outcome unknown")]);

    expect(resolveSingleFailure(error)).toEqual({ outcome: "unknown", retryable: false });
  });

  it("combines retryability and exposes only an agreed provider code", () => {
    const createFailure = (code: string, retryable: boolean) => ({
      error: new PlatformMessageNotDispatchedError("provider rejected message", {
        cause: new Error("provider rejected message"),
        retryable,
        publicError: { code },
      }),
    });

    expect(
      resolveChannelDeliveryTerminalFromFailures({
        deliveredCount: 0,
        failures: [createFailure("230099", false), createFailure("230099", true)],
      }),
    ).toEqual({
      outcome: "failed",
      retryable: true,
      error: { code: "230099" },
    });
    expect(
      resolveChannelDeliveryTerminalFromFailures({
        deliveredCount: 0,
        failures: [createFailure("230099", false), createFailure("230001", true)],
      }),
    ).toEqual({ outcome: "failed", retryable: true, error: { code: "230099" } });
    expect(
      resolveChannelDeliveryTerminalFromFailures({
        deliveredCount: 0,
        failures: [createFailure("230001", true), createFailure("230099", false)],
      }),
    ).toEqual({ outcome: "failed", retryable: true, error: { code: "230099" } });
    expect(
      resolveChannelDeliveryTerminalFromFailures({
        deliveredCount: 0,
        failures: [createFailure("230099", false), createFailure("230001", false)],
      }),
    ).toEqual({ outcome: "failed", retryable: false });

    const retryableStart = createFailure("230001", true).error;
    const permanentFallback = createFailure("230099", false).error;
    for (const errors of [
      [retryableStart, permanentFallback],
      [permanentFallback, retryableStart],
    ]) {
      expect(
        resolveChannelDeliveryTerminalFromFailures({
          deliveredCount: 0,
          failures: [{ error: new AggregateError(errors) }],
        }),
      ).toEqual({ outcome: "failed", retryable: true, error: { code: "230099" } });
    }

    const partial = {
      error: createChannelPartialDeliveryError(
        new PlatformMessageNotDispatchedError("provider rejected edit", {
          cause: new Error("provider rejected edit"),
          retryable: false,
          publicError: { code: "230001" },
        }),
        { visibleReplySent: true },
      ),
    };
    expect(
      resolveChannelDeliveryTerminalFromFailures({
        deliveredCount: 0,
        failures: [partial, createFailure("230099", false)],
      }),
    ).toEqual({ outcome: "partial_failure", retryable: false, error: { code: "230099" } });
  });

  it("records delivery failure separately without raw terminal details", () => {
    const events: TrustedMessageAuditEvent[] = [];
    const unsubscribe = onTrustedMessageAuditEvent((event) => events.push(event));
    try {
      emitChannelDeliveryTerminalObservations({
        terminal: { outcome: "failed", retryable: false, error: { code: "230099" } },
        channel: "feishu",
        to: "chat:redacted",
        agentId: "main",
        sessionKey: "agent:main:feishu:direct:redacted",
        chatType: "direct",
        startedAt: Date.now(),
      });
    } finally {
      unsubscribe();
    }

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: "message.outbound.finished",
      direction: "outbound",
      status: "failed",
      outcome: "failed",
      errorCode: "message_delivery_failed",
      failureStage: "platform_send",
      resultCount: 0,
    });
    expect(JSON.stringify(events)).not.toContain("230099");
    expect(JSON.stringify(events)).not.toContain("agent:main:feishu");
  });

  it.each([
    ["matching", "230099", { code: "230099" }],
    ["conflicting", "230001", undefined],
  ] as const)(
    "%s provider codes remain conservative across delivery-owner merges",
    (_name, nextCode, expectedError) => {
      const nextFailure = new PlatformMessageNotDispatchedError("provider rejected message", {
        cause: new Error("provider rejected message"),
        retryable: false,
        publicError: { code: nextCode },
      });

      expect(
        applySettledChannelDeliveryFailures(
          {
            queuedFinal: true,
            counts: { tool: 0, block: 0, final: 1 },
            deliveryTerminal: {
              outcome: "partial_failure",
              retryable: false,
              error: { code: "230099" },
            },
          },
          [{ kind: "final", error: nextFailure }],
        ),
      ).toEqual({
        queuedFinal: false,
        counts: { tool: 0, block: 0, final: 0 },
        failedCounts: { final: 1 },
        deliveryTerminal: {
          outcome: "partial_failure",
          retryable: false,
          ...(expectedError ? { error: expectedError } : {}),
        },
      });
    },
  );
});
