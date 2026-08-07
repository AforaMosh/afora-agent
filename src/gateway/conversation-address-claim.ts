import type {
  ConversationSendParams,
  ConversationTurnParams,
} from "../../packages/gateway-protocol/src/schema/agent.js";
import type { ConversationRecord } from "../config/sessions/conversation-registry.js";
import { ConversationInputError } from "./conversation-errors.js";

type ConversationAddressClaim = NonNullable<
  ConversationSendParams["expectedAddress"] | ConversationTurnParams["expectedAddress"]
>;

/** Reject a list-derived address if its live delivery tuple changed before I/O. */
export function assertConversationAddressClaim(
  conversation: ConversationRecord,
  expected: ConversationAddressClaim | undefined,
): void {
  if (!expected) {
    return;
  }
  if (
    conversation.channel !== expected.channel ||
    conversation.accountId !== expected.accountId ||
    conversation.kind !== expected.kind ||
    conversation.target !== expected.target ||
    (conversation.threadId ?? null) !== (expected.threadId ?? null)
  ) {
    throw new ConversationInputError(
      `Conversation ${conversation.conversationRef} changed after conversations_list; list again before sending`,
    );
  }
}
