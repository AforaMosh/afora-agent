// RPC adapter for chat.abort; cancellation policy lives in the sibling modules.
import {
  ErrorCodes,
  errorShape,
  validateChatAbortParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import {
  abortEmbeddedAgentRun,
  resolveActiveEmbeddedRunIdentity,
} from "../../agents/embedded-agent-runner/runs.js";
import { runReplyRecoveryUserAbort } from "../../auto-reply/reply/reply-recovery-owner.js";
import {
  replyRunRegistry,
  resolveActiveReplyOperationForAbortSignal,
  resolveActiveReplyOperationForSessionId,
  resolveReplyOperationRunId,
  type ReplyOperation,
} from "../../auto-reply/reply/reply-run-registry.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { parseAgentSessionKey } from "../../sessions/session-key-utils.js";
import { abortChatRunById, type ChatAbortControllerEntry } from "../chat-abort.js";
import { abortQueuedChatTurnById, type QueuedChatTurnEntry } from "../chat-queued-turns.js";
import { pendingChatSendDedupeKey } from "../server-shared.js";
import { loadSessionEntry, resolveSessionStoreKey } from "../session-utils.js";
import { asWorkerInferenceControl } from "../worker-environments/inference-control.js";
import {
  canRequesterAbortChatRun,
  canRequesterAbortPreRegisteredRun,
  readPreRegisteredAgentDedupePayloadForSession,
  resolveChatAbortRequester,
  resolveStoredGlobalRunAgentId,
  writePreRegisteredAgentAbort,
  writePreRegisteredChatAbort,
} from "./chat-abort-authorization.js";
import {
  abortChatRunsForSessionKeyWithPartials,
  cancelWorkerInferenceForSession,
  createChatAbortOps,
  persistAbortedPartials,
} from "./chat-abort-runtime.js";
import {
  normalizeOptionalChatText as normalizeOptionalText,
  normalizeUnknownChatText as normalizeUnknownText,
} from "./chat-text-normalization.js";
import type { GatewayRequestContext, GatewayRequestHandlerOptions } from "./types.js";
import { assertValidParams } from "./validation.js";

type ChatAbortLifecycle = {
  onAuthorizedAfterQueuedAbort?: () => boolean;
  onAuthorizedAfterExactMiss?: () => boolean;
  excludeRunIds?: ReadonlySet<string>;
  replyRecoveryAbortHandledExternally?: boolean;
};

type ChatAbortTarget = Pick<
  ChatAbortControllerEntry | QueuedChatTurnEntry,
  "sessionKey" | "agentId" | "ownerConnId" | "ownerDeviceId"
>;

function resolveChatAbortReplyOperation(params: {
  active?: ChatAbortControllerEntry;
  sessionId?: string;
  sessionKeys: readonly (string | undefined)[];
}): ReplyOperation | undefined {
  if (params.active) {
    return resolveActiveReplyOperationForAbortSignal(params.active.controller.signal);
  }
  for (const sessionKey of params.sessionKeys) {
    const operation = sessionKey ? replyRunRegistry.get(sessionKey) : undefined;
    if (operation && (!params.sessionId || operation.sessionId === params.sessionId)) {
      return operation;
    }
  }
  return params.sessionId ? resolveActiveReplyOperationForSessionId(params.sessionId) : undefined;
}

async function runChatAbortWithReplyRecovery<T extends { aborted: boolean }>(params: {
  operation: ReplyOperation | undefined;
  recoveryRun?: Parameters<typeof runReplyRecoveryUserAbort>[0]["recoveryRun"];
  logLabel: string;
  handledExternally: boolean;
  abort: () => T | Promise<T>;
}): Promise<T & { recoveryPersistenceErrors?: string[] }> {
  if (params.handledExternally) {
    return await params.abort();
  }
  return await runReplyRecoveryUserAbort({
    operation: params.operation,
    recoveryRun: params.recoveryRun,
    abort: params.abort,
    logLabel: params.logLabel,
  });
}

function resolveChatAbortRecoveryRun(params: {
  operation: ReplyOperation | undefined;
  sessionId?: string;
  sessionKey: string;
  storePath: string;
}): Parameters<typeof runReplyRecoveryUserAbort>[0]["recoveryRun"] {
  const identity = params.sessionId
    ? resolveActiveEmbeddedRunIdentity(params.sessionId)
    : undefined;
  if (
    identity &&
    params.operation &&
    resolveReplyOperationRunId(params.operation) === identity.runId
  ) {
    return undefined;
  }
  return identity
    ? {
        ...identity,
        sessionKey: params.sessionKey,
        storePath: params.storePath,
      }
    : undefined;
}

function respondRecoveryPersistenceFailure(respond: GatewayRequestHandlerOptions["respond"]): void {
  respond(
    false,
    undefined,
    errorShape(
      ErrorCodes.UNAVAILABLE,
      "Run cancellation was accepted, but recovery state could not be persisted. Retry chat.abort.",
      { retryable: true },
    ),
  );
}

export async function handleChatAbortRequestWithLifecycle(
  { params, respond, context, client }: GatewayRequestHandlerOptions,
  lifecycle: ChatAbortLifecycle = {},
): Promise<void> {
  if (!assertValidParams(params, validateChatAbortParams, "chat.abort", respond)) {
    return;
  }
  const {
    sessionKey: rawSessionKey,
    runId,
    preserveSideRuns,
  } = params as {
    sessionKey: string;
    agentId?: string;
    runId?: string;
    preserveSideRuns?: boolean;
  };
  const agentIdOverride = normalizeOptionalText((params as { agentId?: string }).agentId);
  const abortCfg = context.getRuntimeConfig();
  const defaultAgentId = resolveDefaultAgentId(abortCfg);
  const parsedAbortSessionKey = parseAgentSessionKey(rawSessionKey);
  const abortSessionResolvesGlobal =
    resolveSessionStoreKey({ cfg: abortCfg, sessionKey: rawSessionKey }) === "global";
  const inferredGlobalAgentId =
    !agentIdOverride && parsedAbortSessionKey && abortSessionResolvesGlobal
      ? normalizeAgentId(parsedAbortSessionKey.agentId)
      : undefined;
  const abortAgentId =
    agentIdOverride ??
    inferredGlobalAgentId ??
    (abortSessionResolvesGlobal ? defaultAgentId : undefined);
  if (
    agentIdOverride &&
    parsedAbortSessionKey &&
    normalizeAgentId(parsedAbortSessionKey.agentId) !== normalizeAgentId(agentIdOverride)
  ) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        `agentId "${agentIdOverride}" does not match session key "${rawSessionKey}"`,
      ),
    );
    return;
  }
  const canonicalAbortSessionKey =
    abortAgentId && abortSessionResolvesGlobal ? "global" : rawSessionKey;

  const ops = createChatAbortOps(context);
  const requester = resolveChatAbortRequester(client);

  const sessionLoadOptions = abortAgentId ? { agentId: abortAgentId } : undefined;
  const {
    entry: abortSessionEntry,
    storePath: abortStorePath,
    canonicalKey: persistedAbortSessionKey,
  } = loadSessionEntry(rawSessionKey, sessionLoadOptions);
  const cancelWorkerRun = (sessionId = abortSessionEntry?.sessionId): string[] =>
    requester.isAdmin
      ? cancelWorkerInferenceForSession({ context, sessionId, ...(runId ? { runId } : {}) })
      : [];
  const respondWithWorkerRuns = (localRunIds: string[], sessionId?: string): void => {
    const runIds = [...new Set([...localRunIds, ...cancelWorkerRun(sessionId)])];
    respond(true, { ok: true, aborted: runIds.length > 0, runIds });
  };

  if (!runId) {
    const operation = resolveChatAbortReplyOperation({
      sessionId: abortSessionEntry?.sessionId,
      sessionKeys: [canonicalAbortSessionKey, rawSessionKey],
    });
    const recoveryRun = resolveChatAbortRecoveryRun({
      operation,
      sessionId: abortSessionEntry?.sessionId,
      sessionKey: persistedAbortSessionKey,
      storePath: abortStorePath,
    });
    const recoveryRunId = recoveryRun
      ? (context.chatRunState.registry.peek(recoveryRun.runId)?.clientRunId ?? recoveryRun.runId)
      : undefined;
    let recoveryFallbackAccepted = false;
    const onAuthorizedAfterQueuedAbort =
      lifecycle.onAuthorizedAfterQueuedAbort ??
      (recoveryRun
        ? () => {
            recoveryFallbackAccepted = abortEmbeddedAgentRun(recoveryRun.sessionId);
            return recoveryFallbackAccepted;
          }
        : undefined);
    const res = await runChatAbortWithReplyRecovery({
      operation,
      recoveryRun,
      logLabel: canonicalAbortSessionKey,
      handledExternally: lifecycle.replyRecoveryAbortHandledExternally === true,
      abort: async () => {
        const result = await abortChatRunsForSessionKeyWithPartials({
          context,
          ops,
          sessionKey: canonicalAbortSessionKey,
          sessionKeyAliases:
            canonicalAbortSessionKey === rawSessionKey ? undefined : [rawSessionKey],
          agentId: abortAgentId,
          sessionId: abortSessionEntry?.sessionId,
          defaultAgentId,
          abortOrigin: "rpc",
          stopReason: "rpc",
          requester,
          preserveSideRuns,
          excludeRunIds: lifecycle.excludeRunIds,
          onAuthorizedAfterQueuedAbort,
        });
        if (recoveryFallbackAccepted && recoveryRunId && !result.runIds.includes(recoveryRunId)) {
          return { ...result, runIds: [...result.runIds, recoveryRunId] };
        }
        return result;
      },
    });
    if (res.unauthorized) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unauthorized"));
      return;
    }
    if (res.recoveryPersistenceErrors?.length) {
      respondRecoveryPersistenceFailure(respond);
      return;
    }
    respond(true, { ok: true, aborted: res.aborted, runIds: res.runIds });
    return;
  }
  const normalizedAgentIdOverride = abortAgentId?.toLowerCase();
  const authorizeRunTarget = (target: ChatAbortTarget): boolean => {
    if (
      target.sessionKey !== rawSessionKey &&
      target.sessionKey !== canonicalAbortSessionKey &&
      !canRequesterAbortChatRun(target, requester, { requireOwnerMatch: true })
    ) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "runId does not match sessionKey"),
      );
      return false;
    }
    if (
      normalizedAgentIdOverride &&
      target.sessionKey === "global" &&
      resolveStoredGlobalRunAgentId(target.agentId, defaultAgentId) !== normalizedAgentIdOverride
    ) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "runId does not match agentId"),
      );
      return false;
    }
    if (!canRequesterAbortChatRun(target, requester)) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unauthorized"));
      return false;
    }
    return true;
  };

  const active = context.chatAbortControllers.get(runId);
  if (!active) {
    const readPendingRunForAbort = (
      entry: GatewayRequestContext["dedupe"] extends Map<string, infer T> ? T | undefined : never,
    ) => {
      for (const sessionKey of new Set([canonicalAbortSessionKey, rawSessionKey])) {
        const payload = readPreRegisteredAgentDedupePayloadForSession({
          entry,
          runId,
          sessionKey,
          agentId: abortAgentId,
          defaultAgentId,
          includeHidden: true,
        });
        if (payload) {
          return {
            sessionKey: normalizeUnknownText(payload.sessionKey) ? sessionKey : undefined,
            payload,
          };
        }
      }
      return undefined;
    };
    const pendingChatMatch = readPendingRunForAbort(
      context.dedupe.get(pendingChatSendDedupeKey(runId)),
    );
    if (pendingChatMatch) {
      if (!canRequesterAbortPreRegisteredRun(pendingChatMatch.payload, requester)) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unauthorized"));
        return;
      }
      writePreRegisteredChatAbort({
        context,
        runId,
        stopReason: "rpc",
        attemptId: normalizeUnknownText(pendingChatMatch.payload.attemptId),
      });
      respondWithWorkerRuns([runId]);
      return;
    }
    const pendingAgentEntry = context.dedupe.get(`agent:${runId}`);
    const pendingAgentMatch = readPendingRunForAbort(pendingAgentEntry);
    if (pendingAgentMatch) {
      const pendingAgentPayload = pendingAgentMatch.payload;
      if (!canRequesterAbortPreRegisteredRun(pendingAgentPayload, requester)) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unauthorized"));
        return;
      }
      writePreRegisteredAgentAbort({
        context,
        runId,
        sessionKey: pendingAgentMatch.sessionKey,
        payload: pendingAgentPayload,
        stopReason: "rpc",
      });
      respondWithWorkerRuns([runId]);
      return;
    }
    // Queued followup/collect turns keep a cancel identity after chat.send
    // terminalizes; abort them here so Esc cannot report done while they run.
    const chatQueuedTurns = context.chatQueuedTurns;
    const queued = chatQueuedTurns.get(runId);
    if (queued) {
      if (!authorizeRunTarget(queued)) {
        return;
      }
      const queuedRes = abortQueuedChatTurnById(chatQueuedTurns, {
        runId,
        sessionKey: queued.sessionKey,
        stopReason: "rpc",
        allowSessionMismatch: true,
      });
      respondWithWorkerRuns(queuedRes.aborted ? [runId] : []);
      return;
    }
    const workerSessionId = abortSessionEntry?.sessionId;
    if (
      !workerSessionId ||
      !asWorkerInferenceControl(context.workerEnvironmentService)?.hasInferenceForSession(
        workerSessionId,
        runId,
      )
    ) {
      const additionalAborted = lifecycle.onAuthorizedAfterExactMiss?.() ?? false;
      respond(true, {
        ok: true,
        aborted: additionalAborted,
        runIds: additionalAborted ? [runId] : [],
      });
      return;
    }
    if (!requester.isAdmin) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unauthorized"));
      return;
    }
    respondWithWorkerRuns([]);
    return;
  }
  if (!authorizeRunTarget(active)) {
    return;
  }

  const partialText = context.chatRunState.resolveBuffer(runId).text;
  const operation = resolveChatAbortReplyOperation({
    active,
    sessionId: active.sessionId,
    sessionKeys: [active.sessionKey, canonicalAbortSessionKey, rawSessionKey],
  });
  const recoveryRun = resolveChatAbortRecoveryRun({
    operation,
    sessionId: active.sessionId === abortSessionEntry?.sessionId ? active.sessionId : undefined,
    sessionKey: persistedAbortSessionKey,
    storePath: abortStorePath,
  });
  const recoveryClientRunId = recoveryRun
    ? context.chatRunState.registry.peek(recoveryRun.runId)?.clientRunId
    : undefined;
  const exactRecoveryRunMatches = Boolean(
    recoveryRun && (runId === recoveryRun.runId || runId === recoveryClientRunId),
  );
  const res = await runChatAbortWithReplyRecovery({
    operation,
    recoveryRun,
    logLabel: active.sessionKey,
    handledExternally: lifecycle.replyRecoveryAbortHandledExternally === true,
    abort: () => {
      const result = abortChatRunById(ops, {
        runId,
        sessionKey: active.sessionKey,
        stopReason: "rpc",
      });
      if (!result.aborted && exactRecoveryRunMatches) {
        return { aborted: abortEmbeddedAgentRun(active.sessionId) };
      }
      return result;
    },
  });
  if (res.aborted && active.controlUiVisible !== false && partialText && partialText.trim()) {
    await persistAbortedPartials({
      context,
      sessionKey: active.sessionKey,
      snapshots: [
        {
          runId,
          sessionId: active.sessionId,
          agentId: active.agentId,
          text: partialText,
          abortOrigin: "rpc",
        },
      ],
    });
  }
  if (res.recoveryPersistenceErrors?.length) {
    respondRecoveryPersistenceFailure(respond);
    return;
  }
  respondWithWorkerRuns(res.aborted ? [runId] : [], active.sessionId);
}

export async function handleChatAbortRequest(options: GatewayRequestHandlerOptions): Promise<void> {
  await handleChatAbortRequestWithLifecycle(options);
}
