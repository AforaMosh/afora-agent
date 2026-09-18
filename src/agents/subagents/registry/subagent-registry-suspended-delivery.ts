import {
  ensureDeliveryState,
  isDeliverySuspended,
  MAX_DELIVERY_GENERATION,
} from "./subagent-delivery-state.js";
import {
  SUBAGENT_ENDED_REASON_COMPLETE,
  type SubagentLifecycleEndedReason,
} from "./subagent-lifecycle-events.js";
import { shouldSuppressSubagentRecoverySessionEffects } from "./subagent-recovery-state.js";
import {
  ANNOUNCE_COMPLETION_HARD_EXPIRY_MS,
  safeRemoveAttachmentsDir,
} from "./subagent-registry-helpers.js";
import type { SubagentLifecycleController } from "./subagent-registry-lifecycle.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const SUBAGENT_SUSPENDED_DELIVERY_RETENTION_MS = 7 * 24 * 60 * 60_000;
export const SUBAGENT_SUSPENDED_DELIVERY_WARNING_COUNT = 25;
export const SUBAGENT_SUSPENDED_DELIVERY_HARD_CAP = 50;

// Automatic redrive backoff for a suspended delivery, per logical generation:
// 5m, 10m, 20m, … capped at 24h. Nine redrives (generations 2–10) span ~42.5h,
// well inside the 7-day retention window, so exhaustion always precedes expiry.
const SUSPENDED_DELIVERY_REDRIVE_BASE_DELAY_MS = 5 * 60_000;
const SUSPENDED_DELIVERY_REDRIVE_MAX_DELAY_MS = 24 * 60 * 60_000;

export function isSuspendedPendingFinalDelivery(entry: SubagentRunRecord): boolean {
  return typeof entry.execution.endedAt === "number" && isDeliverySuspended(entry);
}

export function resolveSuspendedDeliveryExpiryMs(): number {
  return SUBAGENT_SUSPENDED_DELIVERY_RETENTION_MS;
}

/** Deterministic delay before the sweeper redrives a delivery suspended at `generation`. */
function resolveSuspendedDeliveryRedriveDelayMs(generation: number): number {
  const shift = Math.min(Math.max(0, Math.floor(generation) - 1), 10);
  return Math.min(
    SUSPENDED_DELIVERY_REDRIVE_BASE_DELAY_MS * 2 ** shift,
    SUSPENDED_DELIVERY_REDRIVE_MAX_DELAY_MS,
  );
}

/** Instant the next automatic redrive is due, or undefined once the generation cap is reached. */
export function resolveSuspendedDeliveryRedriveDueAt(entry: SubagentRunRecord): number | undefined {
  if (!isSuspendedPendingFinalDelivery(entry)) {
    return undefined;
  }
  const delivery = entry.delivery;
  const suspendedAt = delivery?.suspendedAt;
  if (!delivery || typeof suspendedAt !== "number") {
    return undefined;
  }
  const generation = delivery.generation ?? 1;
  if (generation >= MAX_DELIVERY_GENERATION) {
    return undefined;
  }
  return suspendedAt + resolveSuspendedDeliveryRedriveDelayMs(generation);
}

/**
 * Reopens a suspended delivery for one automatic redrive generation, mirroring
 * the operator retry in subagent-completion-delivery.ts. The caller persists
 * the row and resumes the run after this returns.
 */
export function redriveSuspendedPendingFinalDelivery(params: {
  runId: string;
  entry: SubagentRunRecord;
  now: number;
  warn: (message: string, meta?: Record<string, unknown>) => void;
}): void {
  const { entry, now } = params;
  const delivery = ensureDeliveryState(entry);
  const generation = delivery.generation ?? 1;
  Object.assign(delivery, {
    status: "pending" as const,
    disposition: "retryable" as const,
    generation: generation + 1,
    queueId: undefined,
    windowStartedAt: now,
    deadlineAt: now + ANNOUNCE_COMPLETION_HARD_EXPIRY_MS,
    suspendedAt: undefined,
    suspendedReason: undefined,
    attemptCount: 0,
    lastError: undefined,
    nextAttemptAt: undefined,
  });
  entry.cleanupHandled = false;
  params.warn("subagent suspended delivery redriven", {
    runId: entry.runId,
    childSessionKey: entry.childSessionKey,
    requesterSessionKey: entry.requesterSessionKey,
    generation: delivery.generation,
  });
}

export async function discardSuspendedPendingFinalDelivery(params: {
  runId: string;
  entry: SubagentRunRecord;
  now: number;
  reason: "expired";
  resumedRuns: Set<string>;
  clearPendingLifecycleError: (runId: string) => void;
  clearPendingLifecycleTimeout: (runId: string) => void;
  discardTerminalDelivery: typeof SubagentLifecycleController.discardTerminalDelivery;
  completeCleanupBookkeeping: (params: {
    runId: string;
    entry: SubagentRunRecord;
    cleanup: "delete" | "keep";
    completedAt: number;
    skipRequesterSettleWake: true;
  }) => void;
  shouldEmitEndedHookForRun: (params: {
    entry: SubagentRunRecord;
    reason: SubagentLifecycleEndedReason;
  }) => boolean;
  emitSubagentEndedHookForRun: (params: {
    entry: SubagentRunRecord;
    reason: SubagentLifecycleEndedReason;
    sendFarewell: true;
  }) => Promise<void>;
  warn: (message: string, meta?: Record<string, unknown>) => void;
}): Promise<void> {
  const { runId, entry, now, reason, resumedRuns } = params;
  const snapshot = structuredClone(entry);
  const wasResumed = resumedRuns.has(runId);
  params.discardTerminalDelivery(entry, now, reason);
  const suppressSessionEffects = shouldSuppressSubagentRecoverySessionEffects(entry);
  const completionReason = entry.endedReason ?? SUBAGENT_ENDED_REASON_COMPLETE;
  try {
    params.completeCleanupBookkeeping({
      runId,
      entry,
      cleanup: entry.cleanup,
      completedAt: now,
      skipRequesterSettleWake: true,
    });
  } catch (error) {
    for (const key of Object.keys(entry)) {
      Reflect.deleteProperty(entry, key);
    }
    Object.assign(entry, snapshot);
    if (wasResumed) {
      resumedRuns.add(runId);
    }
    throw error;
  }
  resumedRuns.delete(runId);
  params.clearPendingLifecycleError(runId);
  params.clearPendingLifecycleTimeout(runId);
  params.warn("subagent suspended delivery discarded", {
    reason,
    runId: entry.runId,
    childSessionKey: entry.childSessionKey,
    requesterSessionKey: entry.requesterSessionKey,
  });
  if (entry.cleanup === "delete" || !entry.retainAttachmentsOnKeep) {
    await safeRemoveAttachmentsDir(entry);
  }
  if (
    !suppressSessionEffects &&
    entry.expectsCompletionMessage === true &&
    params.shouldEmitEndedHookForRun({ entry, reason: completionReason })
  ) {
    await params.emitSubagentEndedHookForRun({
      entry,
      reason: completionReason,
      sendFarewell: true,
    });
  }
}
