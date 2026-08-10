import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import type { QueuedFollowupReplyBatch } from "../../auto-reply/reply/queue/types.js";
import { isInternalMessageChannel } from "../../utils/message-channel.js";
import type { GatewayRequestContext } from "./types.js";

type TerminalDisposition =
  | { kind: "pending" }
  | { kind: "deliver" }
  | { kind: "delivering" }
  | { kind: "drop"; reason: "non-webchat-origin" }
  | { kind: "settled" };

type DropReason =
  | "non-webchat-origin"
  | "origin-mismatch"
  | "terminal-not-recorded"
  | "already-settled"
  | "delivery-in-flight"
  | "no-visible-content"
  | "delivery-failed";

type LateFollowupDeliveryResult =
  | { kind: "delivered" }
  | { kind: "dropped"; reason: "no-visible-content" };

/** Owns the terminal fact that decides the fate of one late queued reply batch. */
export function createChatSendLateFollowupDisposition(params: {
  runId: string;
  originatingChannel: string;
  logGateway: GatewayRequestContext["logGateway"];
  deliver: (params: {
    runId: string;
    payloads: ReplyPayload[];
  }) => Promise<LateFollowupDeliveryResult>;
}) {
  let terminal: TerminalDisposition = { kind: "pending" };
  const logDrop = (batch: QueuedFollowupReplyBatch, reason: DropReason) => {
    params.logGateway.info("webchat late reply disposition", {
      runId: params.runId,
      followupRunId: batch.runId,
      outcome: "late-and-dropped",
      reason,
    });
  };
  const recordDrop = (batch: QueuedFollowupReplyBatch, reason: DropReason) => {
    terminal = { kind: "settled" };
    logDrop(batch, reason);
  };

  return {
    recordQueued: () => {
      if (terminal.kind !== "pending") {
        return;
      }
      terminal = isInternalMessageChannel(params.originatingChannel)
        ? { kind: "deliver" }
        : { kind: "drop", reason: "non-webchat-origin" };
    },
    deliver: async (batch: QueuedFollowupReplyBatch) => {
      if (terminal.kind === "pending") {
        recordDrop(batch, "terminal-not-recorded");
        return;
      }
      if (terminal.kind === "settled") {
        recordDrop(batch, "already-settled");
        return;
      }
      if (terminal.kind === "delivering") {
        logDrop(batch, "delivery-in-flight");
        return;
      }
      if (terminal.kind === "drop") {
        recordDrop(batch, terminal.reason);
        return;
      }
      if (!isInternalMessageChannel(batch.originatingChannel)) {
        recordDrop(batch, "origin-mismatch");
        return;
      }
      terminal = { kind: "delivering" };
      try {
        const result = await params.deliver({ runId: batch.runId, payloads: batch.payloads });
        if (result.kind === "dropped") {
          recordDrop(batch, result.reason);
          return;
        }
        terminal = { kind: "settled" };
      } catch (error) {
        recordDrop(batch, "delivery-failed");
        throw error;
      }
    },
  };
}
