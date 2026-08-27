// Irc API module exposes the plugin public contract.
export { createAccountStatusSink } from "afora-agent/plugin-sdk/channel-outbound";
export { DEFAULT_ACCOUNT_ID } from "afora-agent/plugin-sdk/account-id";
export type { ChannelPlugin } from "afora-agent/plugin-sdk/channel-core";
export { PAIRING_APPROVED_MESSAGE } from "afora-agent/plugin-sdk/channel-status";
export { buildBaseChannelStatusSummary } from "afora-agent/plugin-sdk/status-helpers";
export { chunkTextForOutbound } from "afora-agent/plugin-sdk/text-chunking";
