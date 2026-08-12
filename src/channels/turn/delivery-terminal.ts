import type { DispatchFromConfigResult } from "../../auto-reply/reply/dispatch-from-config.types.js";
import type { ReplyDispatchKind } from "../../auto-reply/reply/reply-dispatcher.types.js";
import {
  findPlatformMessageNotDispatchedErrors,
  isProvenDeliveryNotSentError,
} from "../../infra/delivery-recovery.shared.js";
import { emitInternalDiagnosticEvent } from "../../infra/diagnostic-events.js";
import { collectErrorGraphCandidates } from "../../infra/errors.js";
import {
  emitOutboundAuditTerminals,
  uniformOutboundAuditTerminals,
} from "../../infra/outbound/outbound-audit.js";
import { normalizeChatType } from "../chat-type.js";
import { isChannelPartialDeliveryError } from "./delivery-result.js";
import type { ChannelDeliveryTerminal } from "./delivery-terminal.types.js";

/** Classifies one settled delivery failure without exposing its raw error graph. */
function resolveChannelDeliveryFailureTerminal(params: {
  error: unknown;
  deliveredBeforeFailure: boolean;
  failedBeforeDeliver?: boolean;
}): Exclude<ChannelDeliveryTerminal, { outcome: "delivered" }> {
  const platformFailures = findPlatformMessageNotDispatchedErrors(params.error);
  const publicError = resolveAgreedPlatformPublicError(platformFailures);
  // Visibility proof wins even when an outer AggregateError also carries no-send branches;
  // otherwise retry/fallback policy could replay a payload that a nested operation delivered.
  const hasPartialDelivery = collectErrorGraphCandidates(params.error, (current) => [
    current.cause,
    current.original,
    current.error,
    current.reason,
    ...(Array.isArray(current.errors) ? current.errors : []),
  ]).some(isChannelPartialDeliveryError);
  const wholeFailureProvesNoSend =
    params.failedBeforeDeliver || isProvenDeliveryNotSentError(params.error);
  if (params.deliveredBeforeFailure || hasPartialDelivery) {
    return {
      outcome: "partial_failure",
      retryable: false,
      ...(publicError ? { error: publicError } : {}),
    };
  }
  if (platformFailures.length > 0 && wholeFailureProvesNoSend) {
    return {
      outcome: "failed",
      retryable: platformFailures.some((failure) => failure.retryable),
      ...(publicError ? { error: publicError } : {}),
    };
  }
  if (wholeFailureProvesNoSend) {
    return { outcome: "failed", retryable: false };
  }
  return { outcome: "unknown", retryable: false };
}

type ChannelDeliveryFailureFact = {
  error: unknown;
  failedBeforeDeliver?: boolean;
};

function resolveAgreedPlatformPublicError(
  failures: readonly ReturnType<typeof findPlatformMessageNotDispatchedErrors>[number][],
): { code?: string } | undefined {
  const permanentFailures = failures.filter((failure) => !failure.retryable);
  const code = permanentFailures[0]?.publicError?.code;
  return code && permanentFailures.every((failure) => failure.publicError?.code === code)
    ? { code }
    : undefined;
}

function resolveAgreedPublicError(
  failures: readonly ChannelDeliveryFailureFact[],
  terminals: readonly Exclude<ChannelDeliveryTerminal, { outcome: "delivered" }>[],
): { code?: string } | undefined {
  return resolveAgreedPlatformPublicError(
    failures.flatMap((failure, index) =>
      terminals[index]?.outcome === "failed"
        ? findPlatformMessageNotDispatchedErrors(failure.error)
        : [],
    ),
  );
}

function resolveMergedPublicError(
  current: Exclude<ChannelDeliveryTerminal, { outcome: "delivered" }>,
  next: Exclude<ChannelDeliveryTerminal, { outcome: "delivered" }>,
): { code?: string } | undefined {
  const currentCode = "error" in current ? current.error?.code : undefined;
  const nextCode = "error" in next ? next.error?.code : undefined;
  return currentCode && currentCode === nextCode ? { code: currentCode } : undefined;
}

/** Aggregates a settled final-delivery set without depending on payload order. */
export function resolveChannelDeliveryTerminalFromFailures(params: {
  deliveredCount: number;
  failures: readonly ChannelDeliveryFailureFact[];
}): ChannelDeliveryTerminal | undefined {
  if (params.failures.length === 0) {
    return params.deliveredCount > 0 ? { outcome: "delivered" } : undefined;
  }
  const terminals = params.failures.map((failure) =>
    resolveChannelDeliveryFailureTerminal({
      error: failure.error,
      deliveredBeforeFailure: false,
      failedBeforeDeliver: failure.failedBeforeDeliver,
    }),
  );
  const error = resolveAgreedPublicError(params.failures, terminals);
  if (
    params.deliveredCount > 0 ||
    terminals.some((terminal) => terminal.outcome === "partial_failure")
  ) {
    return { outcome: "partial_failure", retryable: false, ...(error ? { error } : {}) };
  }
  if (terminals.some((terminal) => terminal.outcome === "unknown")) {
    return { outcome: "unknown", retryable: false };
  }
  return {
    outcome: "failed",
    retryable: terminals.some((terminal) => terminal.outcome === "failed" && terminal.retryable),
    ...(error ? { error } : {}),
  };
}

/** Keeps the most conservative settled fact when separate delivery owners failed. */
function mergeChannelDeliveryTerminal(
  current: ChannelDeliveryTerminal | undefined,
  next: ChannelDeliveryTerminal,
): ChannelDeliveryTerminal {
  if (!current || current.outcome === "delivered") {
    return next;
  }
  if (next.outcome === "delivered") {
    return current;
  }
  const rank = { failed: 1, unknown: 2, partial_failure: 3 } as const;
  const outcome = rank[current.outcome] >= rank[next.outcome] ? current.outcome : next.outcome;
  if (outcome === "unknown") {
    return { outcome, retryable: false };
  }
  // Collapsed terminals no longer expose whether a missing code means no permanent failure or
  // conflicting permanent failures, so preserve a code only when both owners still agree.
  const error = resolveMergedPublicError(current, next);
  if (outcome === "partial_failure") {
    return { outcome, retryable: false, ...(error ? { error } : {}) };
  }
  return {
    outcome,
    retryable: current.retryable || next.retryable,
    ...(error ? { error } : {}),
  };
}

export function applySettledChannelDeliveryFailures(
  result: DispatchFromConfigResult,
  failures: readonly { error: unknown; kind: ReplyDispatchKind }[],
): DispatchFromConfigResult {
  if (failures.length === 0) {
    return result;
  }
  const counts = { ...result.counts };
  const failedCounts = { ...result.failedCounts };
  let hasFailedCounts = false;
  // Settle every counter before classifying finals; intermediate counts still include later
  // failures and would falsely prove that part of the final set was delivered.
  for (const failure of failures) {
    if (isChannelPartialDeliveryError(failure.error)) {
      continue;
    }
    counts[failure.kind] = Math.max(0, counts[failure.kind] - 1);
    failedCounts[failure.kind] = (failedCounts[failure.kind] ?? 0) + 1;
    hasFailedCounts = true;
  }
  // Tool and block failures affect counters only; the terminal describes recipient-visible finals.
  const finalFailures = failures.filter((failure) => failure.kind === "final");
  const settledTerminal =
    finalFailures.length > 0
      ? resolveChannelDeliveryTerminalFromFailures({
          deliveredCount: counts.final,
          failures: finalFailures,
        })
      : undefined;
  return {
    ...result,
    queuedFinal: finalFailures.length > 0 && counts.final === 0 ? false : result.queuedFinal,
    counts,
    ...(hasFailedCounts ? { failedCounts } : {}),
    ...(settledTerminal
      ? { deliveryTerminal: mergeChannelDeliveryTerminal(result.deliveryTerminal, settledTerminal) }
      : {}),
  };
}

export function emitChannelDeliveryTerminalObservations(params: {
  terminal: Exclude<ChannelDeliveryTerminal, { outcome: "delivered" }>;
  channel: string;
  to: string;
  accountId?: string;
  agentId: string;
  runId?: string;
  sessionKey: string;
  chatType: string | undefined;
  startedAt: number;
}): void {
  const conversationKind = normalizeChatType(params.chatType);
  const auditTerminal =
    params.terminal.outcome === "unknown"
      ? ({ outcome: "unknown", failureStage: "platform_send" } as const)
      : ({
          outcome: "failed",
          failureStage: "platform_send",
          sentBeforeError: params.terminal.outcome === "partial_failure",
        } as const);
  emitOutboundAuditTerminals({
    context: {
      channel: params.channel,
      to: params.to,
      ...(params.accountId ? { accountId: params.accountId } : {}),
      ...(params.runId ? { replyPayloadSendingHook: { runId: params.runId } } : {}),
      session: {
        key: params.sessionKey,
        agentId: params.agentId,
        ...(conversationKind ? { conversationKind } : {}),
      },
    },
    terminals: uniformOutboundAuditTerminals(1, auditTerminal),
    startedAt: params.startedAt,
  });
  emitInternalDiagnosticEvent({
    type: "message.delivery.error",
    channel: params.channel,
    sessionKey: params.sessionKey,
    deliveryKind: "other",
    durationMs: Math.max(0, Date.now() - params.startedAt),
    errorCategory: `channel_${params.terminal.outcome}`,
  });
}
