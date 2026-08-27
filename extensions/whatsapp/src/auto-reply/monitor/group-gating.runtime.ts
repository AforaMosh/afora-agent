// Whatsapp plugin module implements group gating behavior.
export {
  implicitMentionKindWhen,
  resolveInboundMentionDecision,
} from "afora-agent/plugin-sdk/channel-mention-gating";
export { hasControlCommand } from "afora-agent/plugin-sdk/command-detection";
export { createChannelHistoryWindow } from "afora-agent/plugin-sdk/reply-history";
export { parseActivationCommand } from "afora-agent/plugin-sdk/group-activation";
export { normalizeE164 } from "../../text-runtime.js";
