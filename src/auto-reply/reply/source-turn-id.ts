import { createHash } from "node:crypto";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { normalizeAccountId } from "../../routing/account-id.js";
import { isInternalMessageChannel } from "../../utils/message-channel.js";

const CHANNEL_SOURCE_TURN_ID_PREFIX = "channel-user:v1:";
const CHANNEL_SOURCE_TURN_ID = Symbol("openclaw.channelSourceTurnId");
const CHANNEL_SOURCE_TURN_SAME_THREAD_REQUIRED = Symbol(
  "openclaw.channelSourceTurnSameThreadRequired",
);

/**
 * Internal-origin turns (gateway chat.send stamps the internal channel as the
 * ingress provider) carry run ids, not provider message ids. Minting a channel
 * source-turn id from them breaks the run-keyed user-turn admission guard;
 * gateway turns own restart via fingerprint admission and client retries.
 */
export function shouldMintChannelSourceTurnId(ingressProvider: string | undefined): boolean {
  return !isInternalMessageChannel(ingressProvider);
}

/**
 * Identifies one inbound channel turn across shared sessions.
 * Provider message ids are not globally unique, so route scope is mandatory.
 */
export function buildChannelSourceTurnId(params: {
  provider?: string;
  accountId?: string;
  conversationId?: string;
  messageId?: string | number;
}): string | undefined {
  const provider = normalizeOptionalLowercaseString(params.provider);
  const conversationId = normalizeOptionalString(params.conversationId);
  const messageId = normalizeOptionalString(
    typeof params.messageId === "number" ? String(params.messageId) : params.messageId,
  );
  if (!provider || !conversationId || !messageId) {
    return undefined;
  }
  const digest = createHash("sha256")
    .update(
      JSON.stringify([provider, normalizeAccountId(params.accountId), conversationId, messageId]),
    )
    .digest("hex");
  return `${CHANNEL_SOURCE_TURN_ID_PREFIX}${digest}`;
}

/** Carries host-only source identity through internal context clones without public type drift. */
export function setChannelSourceTurnId<TContext extends object>(
  context: TContext,
  sourceTurnId: string | undefined,
): void {
  if (sourceTurnId) {
    Reflect.set(context, CHANNEL_SOURCE_TURN_ID, sourceTurnId);
  } else {
    Reflect.deleteProperty(context, CHANNEL_SOURCE_TURN_ID);
  }
}

export function readChannelSourceTurnId<TContext extends object>(context: TContext): string | undefined {
  return Reflect.get(context, CHANNEL_SOURCE_TURN_ID) as string | undefined;
}

/** Carries the original channel adapter's narrowed message-action scope privately. */
export function setChannelSourceTurnSameThreadRequired<TContext extends object>(
  context: TContext,
  sameThreadRequired: boolean | undefined,
): void {
  if (sameThreadRequired === true) {
    Reflect.set(context, CHANNEL_SOURCE_TURN_SAME_THREAD_REQUIRED, true);
  } else {
    Reflect.deleteProperty(context, CHANNEL_SOURCE_TURN_SAME_THREAD_REQUIRED);
  }
}

export function readChannelSourceTurnSameThreadRequired<TContext extends object>(
  context: TContext,
): boolean {
  return Reflect.get(context, CHANNEL_SOURCE_TURN_SAME_THREAD_REQUIRED) === true;
}
