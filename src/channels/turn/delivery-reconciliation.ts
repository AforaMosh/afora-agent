import type { DispatchFromConfigResult } from "../../auto-reply/reply/dispatch-from-config.types.js";
import type { ReplyDispatchKind } from "../../auto-reply/reply/reply-dispatcher.types.js";

/** Reconciles dispatcher counts with authoritative native visibility outcomes. */
export function reconcileNonVisibleChannelDeliveries(
  result: DispatchFromConfigResult,
  nonVisibleCounts: Readonly<Record<ReplyDispatchKind, number>>,
): DispatchFromConfigResult {
  const { deliveryTerminal, ...reconciledResult } = result;
  const counts = {
    tool: Math.max(0, result.counts.tool - nonVisibleCounts.tool),
    block: Math.max(0, result.counts.block - nonVisibleCounts.block),
    final: Math.max(0, result.counts.final - nonVisibleCounts.final),
  };
  const keepDeliveryTerminal =
    deliveryTerminal?.outcome !== "delivered" || nonVisibleCounts.final === 0 || counts.final > 0;
  return {
    ...reconciledResult,
    queuedFinal: result.queuedFinal && counts.final > 0,
    counts,
    // A successful terminal is authoritative only while at least one reconciled final remains
    // visible. Suppression is intentional non-delivery, not a failure terminal.
    ...(keepDeliveryTerminal && deliveryTerminal ? { deliveryTerminal } : {}),
  };
}
