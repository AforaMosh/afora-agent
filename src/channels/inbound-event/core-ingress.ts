import {
  dispatchChannelInboundTurnWithCoreIngress,
  runChannelInboundEventWithCoreIngress,
} from "../turn/kernel.js";
/**
 * Internal paired facade for trusted channel runtime ingress.
 *
 * This is intentionally not an SDK entrypoint: public context construction and
 * public event runners stay unprivileged and therefore resolve an ambiguous subject.
 */
import {
  buildChannelInboundEventContext,
  type BuildChannelInboundEventContextParams,
  type BuiltChannelInboundEventContext,
  type ChannelInboundSupplementalResolutionOptions,
} from "./context.js";
import {
  createCoreChannelInboundMemorySubjectIngress,
  registerCoreChannelInboundMemorySubjectFacts,
} from "./memory-subject-attestation.js";

type MaybePromise<T> = T | Promise<T>;
type CoreInboundContextParams = BuildChannelInboundEventContextParams &
  Partial<ChannelInboundSupplementalResolutionOptions>;

export type CoreChannelInboundEventFacade = Readonly<{
  buildContext: typeof buildChannelInboundEventContext;
  run: typeof import("../turn/kernel.js").runChannelInboundEvent;
  dispatch: typeof import("../turn/kernel.js").dispatchChannelInboundTurn;
}>;

function isPromiseLike<T>(value: MaybePromise<T>): value is Promise<T> {
  return typeof (value as Promise<T> | undefined)?.then === "function";
}

/**
 * Captures structured adapter facts before `extra` can replace finalized fields, then pairs
 * that exact built context with the matching core runner via an opaque ingress capability.
 */
export function createCoreChannelInboundEventFacade(params: {
  ownsChannel: (channel: unknown) => boolean;
}): CoreChannelInboundEventFacade {
  const ingress = createCoreChannelInboundMemorySubjectIngress({
    ownsChannel: params.ownsChannel,
  });
  const buildContext = ((
    input: CoreInboundContextParams,
  ): MaybePromise<BuiltChannelInboundEventContext> => {
    const facts = {
      agentId: input.route.agentId,
      accountId: input.route.accountId ?? input.accountId,
      channel: input.channel,
      conversationId: input.conversation.id,
      conversationKind: input.conversation.kind,
      dmScope: input.route.dmScope,
      nativeChannelId: input.conversation.nativeChannelId,
      senderId: input.sender.id,
      sessionKey: input.route.dispatchSessionKey ?? input.route.routeSessionKey,
    };
    const result = buildChannelInboundEventContext(
      input as never,
    ) as MaybePromise<BuiltChannelInboundEventContext>;
    const register = (ctx: BuiltChannelInboundEventContext): BuiltChannelInboundEventContext => {
      registerCoreChannelInboundMemorySubjectFacts(ctx, ingress, facts);
      return ctx;
    };
    return isPromiseLike(result) ? result.then(register) : register(result);
  }) as typeof buildChannelInboundEventContext;
  const run = ((input: unknown) =>
    runChannelInboundEventWithCoreIngress(
      input as never,
      ingress,
    )) as CoreChannelInboundEventFacade["run"];
  const dispatch = ((input: unknown) =>
    dispatchChannelInboundTurnWithCoreIngress(
      input as never,
      ingress,
    )) as CoreChannelInboundEventFacade["dispatch"];

  return Object.freeze({ buildContext, run, dispatch });
}
