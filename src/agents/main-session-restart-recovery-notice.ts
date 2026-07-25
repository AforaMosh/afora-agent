import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions.js";
import type { SessionTranscriptTurnExpectedState } from "../config/sessions/session-accessor.js";
import type { GatewayRecoveryRuntime } from "../gateway/server-instance-runtime.types.js";
import type { DeliveryContext } from "../utils/delivery-context.shared.js";
import { buildUnresumableSessionNoticeIdempotencyKey } from "./main-session-restart-claim.js";
import { mainSessionRestartRecoveryLog as log } from "./main-session-restart-recovery-shared.js";

export function buildRestartRecoveryExpectedSessionState(
  entry: SessionEntry,
  recoveryState?: { cycleId: string; revision: number },
): SessionTranscriptTurnExpectedState {
  return {
    abortedLastRun: entry.abortedLastRun,
    ...(recoveryState
      ? {
          mainRestartRecoveryCycleId: recoveryState.cycleId,
          mainRestartRecoveryRevision: recoveryState.revision,
        }
      : {}),
    restartRecoveryBeforeAgentReplyState: entry.restartRecoveryBeforeAgentReplyState,
    restartRecoveryDeliveryReceiptState: entry.restartRecoveryDeliveryReceiptState,
    restartRecoveryDeliveryToolCallId: entry.restartRecoveryDeliveryToolCallId,
    restartRecoveryDeliveryRequestFingerprint: entry.restartRecoveryDeliveryRequestFingerprint,
    restartRecoveryDeliveryRunId: entry.restartRecoveryDeliveryRunId,
    restartRecoveryDeliverySourceRunId: entry.restartRecoveryDeliverySourceRunId,
    restartRecoveryRequesterAccountId: entry.restartRecoveryRequesterAccountId,
    restartRecoveryRequesterSenderId: entry.restartRecoveryRequesterSenderId,
    restartRecoverySameChannelThreadRequired: entry.restartRecoverySameChannelThreadRequired,
    restartRecoverySourceIngress: entry.restartRecoverySourceIngress,
    restartRecoverySourceReplyDeliveryMode: entry.restartRecoverySourceReplyDeliveryMode,
    restartRecoveryTerminalRunIds: entry.restartRecoveryTerminalRunIds,
    status: entry.status,
    updatedAt: entry.updatedAt,
  };
}

export async function sendRestartRecoveryNotice(params: {
  deliveryContext: DeliveryContext;
  entry: SessionEntry;
  gatewayRuntime: GatewayRecoveryRuntime;
  reason: string;
  sessionKey: string;
  text: string;
}): Promise<void> {
  const messageParams: Record<string, unknown> = {
    to: params.deliveryContext.to,
    message: params.text,
    bestEffort: true,
    ...(params.deliveryContext.threadId != null
      ? { threadId: params.deliveryContext.threadId }
      : {}),
  };
  const actionParams: Record<string, unknown> = {
    channel: params.deliveryContext.channel,
    action: "send",
    sessionKey: params.sessionKey,
    sessionId: params.entry.sessionId,
    idempotencyKey: buildUnresumableSessionNoticeIdempotencyKey(params.entry),
    params: messageParams,
  };
  const accountId = normalizeOptionalString(params.deliveryContext.accountId);
  if (accountId) {
    actionParams.accountId = accountId;
  }
  try {
    await params.gatewayRuntime.sendRecoveryNotice(actionParams, 10_000);
    log.info(
      `sent interrupted main session recovery notice: ${params.sessionKey} (${params.reason})`,
    );
  } catch (error) {
    log.warn(
      `failed to send interrupted main session recovery notice ${params.sessionKey}: ${String(error)}`,
    );
  }
}
