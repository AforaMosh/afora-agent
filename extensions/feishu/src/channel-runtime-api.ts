// Feishu API module exposes the plugin public contract.
export type {
  ChannelMessageActionName,
  ChannelMeta,
  ChannelPlugin,
  ClawdbotConfig,
} from "../runtime-api.js";

export { DEFAULT_ACCOUNT_ID } from "afora-agent/plugin-sdk/account-resolution";
export { createActionGate } from "afora-agent/plugin-sdk/channel-actions";
export {
  buildProbeChannelStatusSummary,
  createDefaultChannelRuntimeState,
} from "afora-agent/plugin-sdk/status-helpers";
export { PAIRING_APPROVED_MESSAGE } from "afora-agent/plugin-sdk/channel-status";
