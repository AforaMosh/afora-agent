import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createChatSendLateFollowupDisposition } from "./chat-send-late-followup.js";

describe("chat.send late queued follow-up disposition", () => {
  it.each([
    {
      name: "non-WebChat originating run",
      originatingChannel: "discord",
      batchChannel: "discord",
      reason: "non-webchat-origin",
    },
    {
      name: "mismatched batch origin",
      originatingChannel: "webchat",
      batchChannel: "discord",
      reason: "origin-mismatch",
    },
  ])("records late-and-dropped for $name", async ({ originatingChannel, batchChannel, reason }) => {
    const info = vi.fn();
    const deliver = vi.fn(async () => ({ kind: "delivered" as const }));
    const disposition = createChatSendLateFollowupDisposition({
      runId: "original-run",
      originatingChannel,
      logGateway: { info } as never,
      deliver,
    });
    disposition.recordQueued();

    await disposition.deliver({
      kind: "queued-followup",
      runId: "followup-run",
      originatingChannel: batchChannel,
      payloads: [{ text: "must not leak" }],
    });

    expect(deliver).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith("webchat late reply disposition", {
      runId: "original-run",
      followupRunId: "followup-run",
      outcome: "late-and-dropped",
      reason,
    });
  });

  it("records late-and-dropped when WebChat cannot project visible content", async () => {
    const info = vi.fn();
    const deliver = vi.fn(async () => ({
      kind: "dropped" as const,
      reason: "no-visible-content" as const,
    }));
    const disposition = createChatSendLateFollowupDisposition({
      runId: "original-run",
      originatingChannel: "webchat",
      logGateway: { info } as never,
      deliver,
    });
    disposition.recordQueued();

    await disposition.deliver({
      kind: "queued-followup",
      runId: "followup-run",
      originatingChannel: "webchat",
      payloads: [{ location: { latitude: 48.858844, longitude: 2.294351 } }],
    });

    expect(info).toHaveBeenCalledWith("webchat late reply disposition", {
      runId: "original-run",
      followupRunId: "followup-run",
      outcome: "late-and-dropped",
      reason: "no-visible-content",
    });
  });

  it("claims delivery before awaiting and drops a concurrent duplicate", async () => {
    const info = vi.fn();
    const delivery = createDeferred<{ kind: "delivered" }>();
    const deliver = vi.fn(() => delivery.promise);
    const disposition = createChatSendLateFollowupDisposition({
      runId: "original-run",
      originatingChannel: "webchat",
      logGateway: { info } as never,
      deliver,
    });
    disposition.recordQueued();
    const first = disposition.deliver({
      kind: "queued-followup",
      runId: "first-followup",
      originatingChannel: "webchat",
      payloads: [{ text: "first" }],
    });
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());

    await disposition.deliver({
      kind: "queued-followup",
      runId: "duplicate-followup",
      originatingChannel: "webchat",
      payloads: [{ text: "duplicate" }],
    });

    expect(info).toHaveBeenCalledWith("webchat late reply disposition", {
      runId: "original-run",
      followupRunId: "duplicate-followup",
      outcome: "late-and-dropped",
      reason: "delivery-in-flight",
    });
    expect(deliver).toHaveBeenCalledOnce();
    delivery.resolve({ kind: "delivered" });
    await first;
  });

  it("settles a failed delivery as an explicit drop", async () => {
    const info = vi.fn();
    const deliver = vi.fn(async () => {
      throw new Error("broadcast failed");
    });
    const disposition = createChatSendLateFollowupDisposition({
      runId: "original-run",
      originatingChannel: "webchat",
      logGateway: { info } as never,
      deliver,
    });
    disposition.recordQueued();
    const batch = {
      kind: "queued-followup" as const,
      runId: "failed-followup",
      originatingChannel: "webchat",
      payloads: [{ text: "reply" }],
    };

    await expect(disposition.deliver(batch)).rejects.toThrow("broadcast failed");
    expect(info).toHaveBeenCalledWith("webchat late reply disposition", {
      runId: "original-run",
      followupRunId: "failed-followup",
      outcome: "late-and-dropped",
      reason: "delivery-failed",
    });

    await disposition.deliver({ ...batch, runId: "retry-after-failure" });
    expect(info).toHaveBeenCalledWith("webchat late reply disposition", {
      runId: "original-run",
      followupRunId: "retry-after-failure",
      outcome: "late-and-dropped",
      reason: "already-settled",
    });
    expect(deliver).toHaveBeenCalledOnce();
  });
});
