import { recordChannelHistoryEntryWithMedia } from "../../auto-reply/reply/history.js";
import { toHistoryMediaEntries } from "../inbound-event/media.js";
import {
  attestCoreChannelInboundMemorySubjectContext,
  bindAttestedChannelInboundMemorySubject,
  clearBoundChannelInboundMemorySubject,
} from "../inbound-event/memory-subject-attestation.js";
import {
  assembleResolvedChannelTurn,
  dispatchAssembledChannelTurn as dispatchAssembledChannelTurnImpl,
  dispatchAssembledRoutedChannelTurn as dispatchAssembledRoutedChannelTurnImpl,
  dispatchRoutedChannelTurn as dispatchRoutedChannelTurnImpl,
  runPreparedInboundReply as runPreparedInboundReplyImpl,
} from "./lifecycle.js";
import { resolveRecordSessionKey } from "./record-session-key.js";

export { recordChannelBotPairLoopAndCheckSuppression } from "./bot-loop-protection.js";

export type { ChannelBotLoopProtectionFacts } from "./bot-loop-protection.js";

export {
  deliverInboundReplyWithMessageSendContext,
  isDurableInboundReplyDeliveryHandled,
  throwIfDurableInboundReplyDeliveryFailed,
} from "./durable-delivery.js";
export type {
  DurableInboundReplyDeliveryOptions,
  DurableInboundReplyDeliveryParams,
} from "./durable-delivery.js";
import type {
  AssembledChannelTurn,
  ChannelEventClass,
  ChannelProviderOwnedMessageSendingDeliveryAdapter,
  ChannelTurnAdmission,
  ChannelTurnDeliveryAdapter,
  ChannelTurnLogEvent,
  ChannelTurnPlan,
  ChannelTurnResult,
  DispatchedChannelTurnResult,
  NormalizedTurnInput,
  PreflightFacts,
  PreparedChannelTurn,
  RunChannelTurnParams,
} from "./types.js";

export {
  hasFinalChannelTurnDispatch,
  hasVisibleChannelTurnDispatch,
  resolveChannelTurnDispatchCounts,
} from "./dispatch-result.js";
export type { ChannelTurnResult } from "./types.js";

export function dispatchAssembledChannelTurn(
  params: AssembledChannelTurn,
): Promise<ChannelTurnResult> {
  return dispatchAssembledChannelTurnImpl(params);
}

export const dispatchChannelInboundReply = dispatchAssembledChannelTurn;

export function dispatchChannelInboundTurn(
  plan: ChannelTurnPlan<ChannelProviderOwnedMessageSendingDeliveryAdapter>,
): Promise<ChannelTurnResult>;
export function dispatchChannelInboundTurn(plan: ChannelTurnPlan): Promise<ChannelTurnResult>;
export function dispatchChannelInboundTurn(
  plan: ChannelTurnPlan<ChannelTurnDeliveryAdapter>,
): Promise<ChannelTurnResult> {
  return dispatchRoutedChannelTurnImpl(plan);
}

/**
 * Internal-only paired dispatch entrypoint for a facade-built context.
 *
 * Direct `dispatch` users arrive after adapter resolution, so they bypass the
 * raw-event runner that normally attests, assembles, and binds the issuer.
 * Keep that lifecycle here rather than granting authority to public dispatch.
 */
export async function dispatchChannelInboundTurnWithCoreIngress(
  plan: ChannelTurnPlan<ChannelTurnDeliveryAdapter>,
  coreIngress: object,
): Promise<ChannelTurnResult> {
  attestCoreChannelInboundMemorySubjectContext({
    ctx: plan.ctxPayload,
    ingress: coreIngress,
    runChannel: plan.channel,
  });
  const assembled = assembleResolvedChannelTurn(plan);
  try {
    await bindAttestedChannelInboundMemorySubject(
      assembled.ctxPayload,
      resolveRecordSessionKey(assembled),
    );
    return await dispatchAssembledRoutedChannelTurnImpl(
      assembled as Parameters<typeof dispatchAssembledRoutedChannelTurnImpl>[0],
    );
  } finally {
    // An exact context/issuer pair is single-turn authority even when dispatch
    // exits before session recording. Never leave it reusable by a later call.
    clearBoundChannelInboundMemorySubject(assembled.ctxPayload);
  }
}

export const runPreparedInboundReply = runPreparedInboundReplyImpl;

const DEFAULT_EVENT_CLASS: ChannelEventClass = {
  kind: "message",
  canStartAgentTurn: true,
};

function isAdmission(value: unknown): value is ChannelTurnAdmission {
  if (!value || typeof value !== "object") {
    return false;
  }
  const kind = (value as { kind?: unknown }).kind;
  return kind === "dispatch" || kind === "observeOnly" || kind === "handled" || kind === "drop";
}

function normalizePreflight(
  value: PreflightFacts | ChannelTurnAdmission | null | undefined,
): PreflightFacts {
  if (!value) {
    return {};
  }
  if (isAdmission(value)) {
    return { admission: value };
  }
  return value;
}

function assertPreparedDispatchLifecycle<TDispatchResult>(
  turn: PreparedChannelTurn<TDispatchResult>,
  turnAdoptionLifecycle: RunChannelTurnParams<unknown>["turnAdoptionLifecycle"],
): void {
  const lifecycle = turn.runDispatchLifecycle;
  if (!lifecycle) {
    throw new Error(
      "runChannelInboundEvent prepared turns must declare runDispatchLifecycle when creating runDispatch",
    );
  }
  if (turnAdoptionLifecycle && lifecycle.turnAdoptionLifecycle !== turnAdoptionLifecycle) {
    throw new Error(
      "runChannelInboundEvent prepared turn runDispatchLifecycle must own the top-level turnAdoptionLifecycle",
    );
  }
}

function emit(params: {
  log?: (event: ChannelTurnLogEvent) => void;
  event: Omit<ChannelTurnLogEvent, "channel" | "accountId">;
  channel: string;
  accountId?: string;
}) {
  params.log?.({
    channel: params.channel,
    accountId: params.accountId,
    ...params.event,
  });
}

function resolveDroppedHistorySender(input: NormalizedTurnInput, preflight: PreflightFacts) {
  return (
    preflight.message?.senderLabel ??
    preflight.message?.envelopeFrom ??
    (typeof input.raw === "object" &&
    input.raw &&
    "sender" in input.raw &&
    typeof (input.raw as { sender?: unknown }).sender === "string"
      ? (input.raw as { sender: string }).sender
      : undefined) ??
    "unknown"
  );
}

function resolveDroppedHistoryBody(input: NormalizedTurnInput, preflight: PreflightFacts) {
  return (
    preflight.message?.bodyForAgent ??
    preflight.message?.body ??
    preflight.message?.rawBody ??
    input.textForAgent ??
    input.rawText
  );
}

async function recordDroppedChannelTurnHistory(params: {
  input: NormalizedTurnInput;
  preflight: PreflightFacts;
  admission?: ChannelTurnAdmission;
}): Promise<void> {
  const admission = params.admission ?? params.preflight.admission;
  if (admission?.kind !== "drop") {
    return;
  }
  const history = params.preflight.history;
  if (!history || history.limit <= 0 || !(history.recordOnDrop || admission.recordHistory)) {
    return;
  }
  const body = resolveDroppedHistoryBody(params.input, params.preflight);
  const entry =
    body.trim().length > 0
      ? {
          sender: resolveDroppedHistorySender(params.input, params.preflight),
          body,
          timestamp: params.input.timestamp,
          messageId: params.input.id,
        }
      : null;
  const media = params.preflight.media;
  await recordChannelHistoryEntryWithMedia({
    historyMap: history.historyMap,
    historyKey: history.key,
    limit: history.limit,
    entry,
    mediaLimit: history.mediaLimit,
    messageId: params.input.id,
    shouldRecord: history.shouldRecord,
    media:
      typeof media === "function"
        ? async () => toHistoryMediaEntries(await media(), { messageId: params.input.id })
        : toHistoryMediaEntries(media, { messageId: params.input.id }),
  });
}

export const recordDroppedChannelInboundHistory = recordDroppedChannelTurnHistory;

async function runChannelTurn<
  TRaw,
  TDispatchResult = DispatchedChannelTurnResult["dispatchResult"],
>(
  params: RunChannelTurnParams<
    TRaw,
    TDispatchResult,
    ChannelProviderOwnedMessageSendingDeliveryAdapter
  >,
): Promise<ChannelTurnResult<TDispatchResult>>;
async function runChannelTurn<
  TRaw,
  TDispatchResult = DispatchedChannelTurnResult["dispatchResult"],
>(params: RunChannelTurnParams<TRaw, TDispatchResult>): Promise<ChannelTurnResult<TDispatchResult>>;
async function runChannelTurn<
  TRaw,
  TDispatchResult = DispatchedChannelTurnResult["dispatchResult"],
>(
  params: RunChannelTurnParams<TRaw, TDispatchResult, ChannelTurnDeliveryAdapter>,
  coreIngress?: object,
): Promise<ChannelTurnResult<TDispatchResult>>;
async function runChannelTurn<
  TRaw,
  TDispatchResult = DispatchedChannelTurnResult["dispatchResult"],
>(
  params: RunChannelTurnParams<TRaw, TDispatchResult, ChannelTurnDeliveryAdapter>,
  coreIngress?: object,
): Promise<ChannelTurnResult<TDispatchResult>> {
  emit({
    ...params,
    event: { stage: "ingest", event: "start" },
  });
  const input = await params.adapter.ingest(params.raw);
  if (!input) {
    const admission: ChannelTurnAdmission = { kind: "drop", reason: "ingest-null" };
    emit({
      ...params,
      event: {
        stage: "ingest",
        event: "drop",
        admission: admission.kind,
        reason: admission.reason,
      },
    });
    return { admission, dispatched: false };
  }
  emit({
    ...params,
    event: { stage: "ingest", event: "done", messageId: input.id },
  });

  const eventClass = (await params.adapter.classify?.(input)) ?? DEFAULT_EVENT_CLASS;
  if (!eventClass.canStartAgentTurn) {
    const admission: ChannelTurnAdmission = {
      kind: "handled",
      reason: `event:${eventClass.kind}`,
    };
    emit({
      ...params,
      event: {
        stage: "classify",
        event: "handled",
        messageId: input.id,
        admission: admission.kind,
        reason: admission.reason,
      },
    });
    return { admission, dispatched: false };
  }

  const preflight = normalizePreflight(await params.adapter.preflight?.(input, eventClass));
  const preflightAdmission = preflight.admission;
  if (
    preflightAdmission &&
    preflightAdmission.kind !== "dispatch" &&
    preflightAdmission.kind !== "observeOnly"
  ) {
    await recordDroppedChannelTurnHistory({
      input,
      preflight,
      admission: preflightAdmission,
    });
    emit({
      ...params,
      event: {
        stage: "preflight",
        event: preflightAdmission.kind === "handled" ? "handled" : "drop",
        messageId: input.id,
        admission: preflightAdmission.kind,
        reason: preflightAdmission.reason,
      },
    });
    return { admission: preflightAdmission, dispatched: false };
  }

  const unresolved = await params.adapter.resolveTurn(input, eventClass, preflight);
  // Public runner calls have no ingress token. A core-injected paired facade must provide the
  // exact opaque capability that registered this context before any facts become authority.
  attestCoreChannelInboundMemorySubjectContext({
    ctx: unresolved.ctxPayload,
    ingress: coreIngress,
    runChannel: params.channel,
  });
  const isRoutedTurn = "route" in unresolved && !("runDispatch" in unresolved);
  const resolved = assembleResolvedChannelTurn(unresolved);
  try {
    await bindAttestedChannelInboundMemorySubject(
      resolved.ctxPayload,
      resolveRecordSessionKey(resolved),
    );
    emit({
      ...params,
      accountId: resolved.accountId ?? params.accountId,
      event: {
        stage: "assemble",
        event: "done",
        messageId: input.id,
        sessionKey: resolved.routeSessionKey,
        admission: resolved.admission?.kind ?? "dispatch",
      },
    });

    const admission = resolved.admission ?? preflightAdmission ?? ({ kind: "dispatch" } as const);
    let result: ChannelTurnResult<TDispatchResult>;
    try {
      if ("runDispatch" in resolved) {
        assertPreparedDispatchLifecycle(resolved, params.turnAdoptionLifecycle);
      }
      const dispatchResult = (
        "runDispatch" in resolved
          ? await runPreparedInboundReply({
              ...resolved,
              admission,
              log: params.log,
              messageId: input.id,
            })
          : isRoutedTurn
            ? await dispatchAssembledRoutedChannelTurnImpl({
                ...(resolved as Parameters<typeof dispatchAssembledRoutedChannelTurnImpl>[0]),
                admission,
                log: params.log,
                messageId: input.id,
                ...(params.turnAdoptionLifecycle
                  ? { turnAdoptionLifecycle: params.turnAdoptionLifecycle }
                  : {}),
              })
            : await dispatchAssembledChannelTurn({
                ...(resolved as AssembledChannelTurn),
                admission,
                log: params.log,
                messageId: input.id,
                ...(params.turnAdoptionLifecycle
                  ? { turnAdoptionLifecycle: params.turnAdoptionLifecycle }
                  : {}),
              })
      ) as ChannelTurnResult<TDispatchResult>;
      result = dispatchResult.dispatched ? { ...dispatchResult, admission } : dispatchResult;
    } catch (err) {
      const failedResult: ChannelTurnResult<TDispatchResult> = {
        admission,
        dispatched: false,
        ctxPayload: resolved.ctxPayload,
        routeSessionKey: resolved.routeSessionKey,
      };
      try {
        await params.adapter.onFinalize?.(failedResult);
      } catch {
        // Preserve the original dispatch error.
      }
      emit({
        ...params,
        accountId: resolved.accountId ?? params.accountId,
        event: {
          stage: "finalize",
          event: "done",
          messageId: input.id,
          sessionKey: resolved.routeSessionKey,
          admission: admission.kind,
        },
      });
      throw err;
    }

    try {
      await params.adapter.onFinalize?.(result);
      emit({
        ...params,
        accountId: resolved.accountId ?? params.accountId,
        event: {
          stage: "finalize",
          event: "done",
          messageId: input.id,
          sessionKey: resolved.routeSessionKey,
          admission: admission.kind,
        },
      });
    } catch (err) {
      emit({
        ...params,
        accountId: resolved.accountId ?? params.accountId,
        event: {
          stage: "finalize",
          event: "error",
          messageId: input.id,
          sessionKey: resolved.routeSessionKey,
          admission: admission.kind,
          error: err,
        },
      });
      throw err;
    }

    return result;
  } finally {
    // A bound issuer is exact-turn authority. Clear it even when dispatch
    // short-circuits before session recording, so a context cannot be replayed.
    clearBoundChannelInboundMemorySubject(resolved.ctxPayload);
  }
}

export function runChannelInboundEvent<
  TRaw,
  TDispatchResult = DispatchedChannelTurnResult["dispatchResult"],
>(
  params: RunChannelTurnParams<
    TRaw,
    TDispatchResult,
    ChannelProviderOwnedMessageSendingDeliveryAdapter
  >,
): Promise<ChannelTurnResult<TDispatchResult>>;
export function runChannelInboundEvent<
  TRaw,
  TDispatchResult = DispatchedChannelTurnResult["dispatchResult"],
>(params: RunChannelTurnParams<TRaw, TDispatchResult>): Promise<ChannelTurnResult<TDispatchResult>>;
export function runChannelInboundEvent<
  TRaw,
  TDispatchResult = DispatchedChannelTurnResult["dispatchResult"],
>(
  params: RunChannelTurnParams<TRaw, TDispatchResult, ChannelTurnDeliveryAdapter>,
): Promise<ChannelTurnResult<TDispatchResult>> {
  return runChannelTurn(params);
}

/** Internal-only entrypoint used by the trusted paired runtime facade. */
export function runChannelInboundEventWithCoreIngress<
  TRaw,
  TDispatchResult = DispatchedChannelTurnResult["dispatchResult"],
>(
  params: RunChannelTurnParams<
    TRaw,
    TDispatchResult,
    ChannelProviderOwnedMessageSendingDeliveryAdapter
  >,
  coreIngress: object,
): Promise<ChannelTurnResult<TDispatchResult>>;
export function runChannelInboundEventWithCoreIngress<
  TRaw,
  TDispatchResult = DispatchedChannelTurnResult["dispatchResult"],
>(
  params: RunChannelTurnParams<TRaw, TDispatchResult>,
  coreIngress: object,
): Promise<ChannelTurnResult<TDispatchResult>>;
export function runChannelInboundEventWithCoreIngress<
  TRaw,
  TDispatchResult = DispatchedChannelTurnResult["dispatchResult"],
>(
  params: RunChannelTurnParams<TRaw, TDispatchResult, ChannelTurnDeliveryAdapter>,
  coreIngress: object,
): Promise<ChannelTurnResult<TDispatchResult>> {
  return runChannelTurn(params, coreIngress);
}
