import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions.js";
import { buildRestartRecoveryClaimCleanupPatch } from "../config/sessions/restart-recovery-state.js";
import {
  applySessionEntryReplacements,
  persistSessionTranscriptTurn,
  type SessionTranscriptTurnLifecyclePatch,
  updateSessionEntry,
} from "../config/sessions/session-accessor.js";
import { appendAssistantMessageToSessionTranscript } from "../config/sessions/transcript.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayRecoveryRuntime } from "../gateway/server-instance-runtime.types.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import {
  hasInterSessionUserProvenance,
  isCompletionReportInputProvenance,
} from "../sessions/input-provenance.js";
import { resolveDefaultAgentId } from "./agent-scope-config.js";
import { isAnnounceRunId } from "./announce-idempotency.js";
import { getTranscriptMessageRole as getMessageRole } from "./embedded-agent-runner/message-visibility.js";
import { buildMainSessionRecoveryClearPatch } from "./main-session-recovery-clear.js";
import type { MainSessionRecoveryObservation } from "./main-session-recovery-state.js";
import { commitMainSessionRecovery } from "./main-session-recovery-store.js";
import { buildUnresumableSessionNoticeIdempotencyKey } from "./main-session-restart-claim.js";
import { resolveRestartRecoveryDeliveryContext } from "./main-session-restart-dispatch.js";
import {
  buildRestartRecoveryExpectedSessionState,
  sendRestartRecoveryNotice,
} from "./main-session-restart-recovery-notice.js";
import {
  canReconcileTerminalDeliveryAtSourceTurnTail,
  buildRecoveryToolResultIdempotencyKey,
  findMessageToolCallIndexInSourceTurn,
  findSourceTurnRange,
  findSuccessfulMessageToolResultIndex,
  hasSiblingAssistantToolCalls,
} from "./main-session-restart-recovery-plan.js";
import {
  mainSessionRestartRecoveryLog as log,
  UNRESUMABLE_SESSION_NOTICE,
} from "./main-session-restart-recovery-shared.js";

export function hasOnlyAnnounceRecoveryRuns(entry: SessionEntry): boolean {
  const runs = entry.restartRecoveryRuns;
  return Boolean(runs?.length && runs.every((run) => isAnnounceRunId(run.runId)));
}

export function hasCompletionReportUserTail(messages: readonly unknown[]): boolean {
  const message = messages.findLast((candidate) => getMessageRole(candidate) === "user");
  if (!message || typeof message !== "object") {
    return false;
  }
  const userMessage = message as { role?: unknown; provenance?: unknown };
  return (
    hasInterSessionUserProvenance(userMessage) &&
    isCompletionReportInputProvenance(userMessage.provenance)
  );
}

export async function reconcileInterruptedCompletionReport(params: {
  entry: SessionEntry;
  source: "announce_runs" | "transcript";
  storePath: string;
  sessionKey: string;
}): Promise<{ outcome: "reconciled" } | { outcome: "changed"; entry: SessionEntry | null }> {
  let didReconcile = false;
  const current = await updateSessionEntry(
    { sessionKey: params.sessionKey, storePath: params.storePath },
    (entry) => {
      const hasRecoveryRuns = Boolean(entry.restartRecoveryRuns?.length);
      const stillMatchesSource =
        params.source === "announce_runs" ? hasOnlyAnnounceRecoveryRuns(entry) : !hasRecoveryRuns;
      if (
        entry.sessionId !== params.entry.sessionId ||
        entry.status !== "running" ||
        entry.abortedLastRun !== true ||
        !stillMatchesSource
      ) {
        return null;
      }
      didReconcile = true;
      const endedAt = Date.now();
      return {
        ...buildRestartRecoveryClaimCleanupPatch({ entry, recordTerminalSource: false }),
        ...buildMainSessionRecoveryClearPatch(entry),
        status: "killed",
        abortedLastRun: false,
        endedAt,
        lastRunError: undefined,
        runtimeMs:
          typeof entry.startedAt === "number" ? Math.max(0, endedAt - entry.startedAt) : undefined,
        updatedAt: endedAt,
      };
    },
    { requireWriteSuccess: true },
  );
  if (didReconcile) {
    log.info(`reconciled interrupted completion report to non-running: ${params.sessionKey}`);
    return { outcome: "reconciled" };
  }
  return { outcome: "changed", entry: current };
}

async function markSessionFailed(params: {
  observation: MainSessionRecoveryObservation;
  storePath: string;
  sessionKey: string;
  reason: string;
}): Promise<boolean> {
  const marked = await commitMainSessionRecovery({
    command: {
      kind: "fail_recovery",
      now: Date.now(),
      observation: params.observation,
    },
    requireWriteSuccess: true,
    target: { sessionKey: params.sessionKey, storePath: params.storePath },
  });
  if (marked.transition.kind === "failed") {
    log.warn(`marked interrupted main session failed: ${params.sessionKey} (${params.reason})`);
    return true;
  }
  return false;
}

type RecoveryCheckpointCompletion =
  | { outcome: "completed" }
  | { outcome: "changed" }
  | { outcome: "unsafe-transcript"; reason: string };

export async function markSessionCompletedAfterRecoveryCheckpoint(params: {
  agentId: string;
  entry: SessionEntry;
  messages: readonly unknown[];
  reason: "delivered-terminal" | "delivered-terminal-receipt" | "handled-silent";
  storePath: string;
  sessionKey: string;
  sourceTurnId?: string;
  toolCallId?: string;
}): Promise<RecoveryCheckpointCompletion> {
  const expectedRecoveryRunId = normalizeOptionalString(params.entry.restartRecoveryDeliveryRunId);
  const expectedRecoverySourceRunId = normalizeOptionalString(
    params.entry.restartRecoveryDeliverySourceRunId,
  );
  const endedAt = Date.now();
  const lifecyclePatch: SessionTranscriptTurnLifecyclePatch = {
    ...buildRestartRecoveryClaimCleanupPatch({
      entry: params.entry,
      recordTerminalSource: expectedRecoverySourceRunId !== undefined,
      terminalSourceRunId: expectedRecoverySourceRunId,
    }),
    abortedLastRun: false,
    endedAt,
    pendingFinalDelivery: undefined,
    pendingFinalDeliveryText: undefined,
    pendingFinalDeliveryCreatedAt: undefined,
    pendingFinalDeliveryLastAttemptAt: undefined,
    pendingFinalDeliveryAttemptCount: undefined,
    pendingFinalDeliveryLastError: undefined,
    pendingFinalDeliveryContext: undefined,
    pendingFinalDeliveryIntentId: undefined,
    restartRecoveryForceSafeTools: undefined,
    restartRecoveryRuns: undefined,
    runtimeMs:
      typeof params.entry.startedAt === "number"
        ? Math.max(0, endedAt - params.entry.startedAt)
        : undefined,
    status: "done",
    updatedAt: endedAt,
  };
  const sourceTurnId = normalizeOptionalString(params.sourceTurnId);
  if (params.reason === "handled-silent" && !sourceTurnId) {
    return {
      outcome: "unsafe-transcript",
      reason: "handled silent checkpoint lacks its durable source turn",
    };
  }
  const sourceTurnRange = sourceTurnId
    ? findSourceTurnRange({
        continuationRunId: expectedRecoveryRunId,
        messages: params.messages,
        sourceTurnId,
      })
    : undefined;
  const toolCallId = normalizeOptionalString(params.toolCallId);
  if (sourceTurnId && sourceTurnRange === undefined) {
    return {
      outcome: "unsafe-transcript",
      reason: "recovery checkpoint cannot be matched to its durable source turn",
    };
  }
  if (sourceTurnRange && sourceTurnRange.endIndex !== params.messages.length) {
    return {
      outcome: "unsafe-transcript",
      reason: "recovery checkpoint belongs to an earlier transcript turn",
    };
  }
  if (toolCallId && !sourceTurnId) {
    return {
      outcome: "unsafe-transcript",
      reason: "terminal delivery lacks its durable source turn",
    };
  }
  const messageToolCallIndex =
    toolCallId && sourceTurnRange
      ? findMessageToolCallIndexInSourceTurn({
          messages: params.messages,
          sourceTurnRange,
          toolCallId,
        })
      : undefined;
  if (toolCallId && messageToolCallIndex === undefined) {
    return {
      outcome: "unsafe-transcript",
      reason: "terminal delivery cannot be matched to its message tool call",
    };
  }
  if (
    messageToolCallIndex !== undefined &&
    hasSiblingAssistantToolCalls(params.messages[messageToolCallIndex])
  ) {
    return {
      outcome: "unsafe-transcript",
      reason: "terminal message tool call has sibling tool work",
    };
  }
  const recoveryToolResultIdempotencyKey =
    toolCallId && sourceTurnId
      ? buildRecoveryToolResultIdempotencyKey(sourceTurnId, toolCallId)
      : undefined;
  const successfulToolResultIndex =
    toolCallId && sourceTurnRange && messageToolCallIndex !== undefined
      ? findSuccessfulMessageToolResultIndex({
          messages: params.messages,
          sourceTurnRange,
          toolCallId,
          toolCallIndex: messageToolCallIndex,
        })
      : undefined;
  if (
    toolCallId &&
    sourceTurnId &&
    sourceTurnRange !== undefined &&
    messageToolCallIndex !== undefined &&
    !canReconcileTerminalDeliveryAtSourceTurnTail({
      messages: params.messages,
      sourceTurnId,
      sourceTurnRange,
      toolCallId,
      toolCallIndex: messageToolCallIndex,
      successfulToolResultIndex,
    })
  ) {
    return {
      outcome: "unsafe-transcript",
      reason:
        successfulToolResultIndex === undefined
          ? "terminal delivery would require an out-of-order transcript repair"
          : "terminal delivery result is followed by unfinished transcript work",
    };
  }
  if (
    toolCallId &&
    sourceTurnId &&
    sourceTurnRange !== undefined &&
    messageToolCallIndex !== undefined &&
    recoveryToolResultIdempotencyKey &&
    successfulToolResultIndex === undefined
  ) {
    const expectedSessionState = buildRestartRecoveryExpectedSessionState(params.entry);
    const persisted = await persistSessionTranscriptTurn(
      {
        agentId: params.agentId,
        sessionId: params.entry.sessionId,
        sessionKey: params.sessionKey,
        storePath: params.storePath,
      },
      {
        expectedSessionId: params.entry.sessionId,
        expectedSessionState,
        messages: [
          {
            idempotencyLookup: "scan",
            message: {
              role: "toolResult",
              toolCallId,
              toolName: "message",
              content: [{ type: "text", text: "Message delivered before gateway restart." }],
              idempotencyKey: recoveryToolResultIdempotencyKey,
              isError: false,
              timestamp: endedAt,
            },
          },
        ],
        sessionLifecyclePatch: lifecyclePatch,
        updateMode: "none",
      },
    );
    const completed = persisted.sessionEntry?.status === "done";
    if (completed) {
      log.info(`reconciled delivered terminal reply after restart: ${params.sessionKey}`);
    }
    return { outcome: completed ? "completed" : "changed" };
  }
  const marked = await applySessionEntryReplacements({
    sessionKeys: [params.sessionKey],
    storePath: params.storePath,
    update: (entries) => {
      const current = entries.find((candidate) => candidate.sessionKey === params.sessionKey);
      const entry = current?.entry;
      if (
        !entry ||
        entry.sessionId !== params.entry.sessionId ||
        entry.status !== "running" ||
        entry.abortedLastRun !== true ||
        normalizeOptionalString(entry.restartRecoveryDeliveryRunId) !== expectedRecoveryRunId ||
        normalizeOptionalString(entry.restartRecoveryDeliverySourceRunId) !==
          expectedRecoverySourceRunId
      ) {
        return { result: false };
      }
      Object.assign(entry, lifecyclePatch);
      return { result: true, replacements: [{ sessionKey: params.sessionKey, entry }] };
    },
  });
  if (marked) {
    log.info(
      params.reason === "delivered-terminal" || params.reason === "delivered-terminal-receipt"
        ? `reconciled delivered terminal reply after restart: ${params.sessionKey}`
        : `reconciled handled silent reply after restart: ${params.sessionKey}`,
    );
  }
  return { outcome: marked ? "completed" : "changed" };
}

async function writeUnresumableSessionNotice(params: {
  agentId: string;
  entry: SessionEntry;
  sessionKey: string;
  storePath: string;
}): Promise<boolean> {
  const result = await appendAssistantMessageToSessionTranscript({
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    expectedSessionId: params.entry.sessionId,
    expectedSessionState: buildRestartRecoveryExpectedSessionState(params.entry),
    storePath: params.storePath,
    text: UNRESUMABLE_SESSION_NOTICE,
    idempotencyKey: buildUnresumableSessionNoticeIdempotencyKey(params.entry),
  }).catch((error: unknown) => ({ ok: false as const, reason: String(error) }));
  if (!result.ok) {
    log.warn(
      `failed to write interrupted main session notice ${params.sessionKey}: ${result.reason}`,
    );
  }
  return result.ok;
}

export async function failUnresumableMainSession(params: {
  cfg?: OpenClawConfig;
  entry: SessionEntry;
  gatewayRuntime: GatewayRecoveryRuntime;
  observation: MainSessionRecoveryObservation;
  reason: string;
  sessionKey: string;
  storePath: string;
}): Promise<"failed" | "skipped"> {
  const deliveryContext = resolveRestartRecoveryDeliveryContext({
    cfg: params.cfg,
    entry: params.entry,
    includeSessionDeliveryFallback: true,
    sessionKey: params.sessionKey,
  });
  if (
    !deliveryContext &&
    !(await writeUnresumableSessionNotice({
      agentId: resolveAgentIdFromSessionKey(
        params.sessionKey,
        params.cfg ? resolveDefaultAgentId(params.cfg) : undefined,
      ),
      entry: params.entry,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
    }))
  ) {
    // Keep ownership for another recovery attempt until its terminal notice is durable.
    return "failed";
  }
  const marked = await markSessionFailed({
    observation: params.observation,
    storePath: params.storePath,
    sessionKey: params.sessionKey,
    reason: params.reason,
  });
  if (!marked) {
    return "skipped";
  }
  if (deliveryContext) {
    await sendRestartRecoveryNotice({
      deliveryContext,
      entry: params.entry,
      gatewayRuntime: params.gatewayRuntime,
      reason: params.reason,
      sessionKey: params.sessionKey,
      text: UNRESUMABLE_SESSION_NOTICE,
    });
  }
  return "failed";
}
