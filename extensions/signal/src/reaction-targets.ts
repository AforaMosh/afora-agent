import type { OutboundDeliveryResult } from "afora-agent/plugin-sdk/channel-send-result";
import type { AforaConfig } from "afora-agent/plugin-sdk/config-contracts";
import type { ReplyPayload } from "afora-agent/plugin-sdk/reply-runtime";
import { registerSignalApprovalReactionTargetForDeliveredPayload } from "./approval-reactions.js";
import { registerSignalQuestionReactionTargetForDeliveredPayload } from "./question-reactions.js";

export function registerSignalReactionTargetsForDeliveredPayload(params: {
  cfg: AforaConfig;
  target: { channel: string; to: string; accountId?: string | null };
  payload: ReplyPayload;
  results: readonly OutboundDeliveryResult[];
  targetAuthor?: string | null;
  targetAuthorUuid?: string | null;
}): void {
  registerSignalQuestionReactionTargetForDeliveredPayload(params);
  registerSignalApprovalReactionTargetForDeliveredPayload(params);
}
