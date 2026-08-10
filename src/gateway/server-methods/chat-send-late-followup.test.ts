import { describe, expect, it, vi } from "vitest";
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
});
