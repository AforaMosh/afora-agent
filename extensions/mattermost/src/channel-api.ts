// Mattermost API module exposes the plugin public contract.
export { createAccountStatusSink } from "afora-agent/plugin-sdk/channel-outbound";
export type { ChannelPlugin } from "afora-agent/plugin-sdk/core";
export { DEFAULT_ACCOUNT_ID } from "afora-agent/plugin-sdk/core";
export { chunkTextForOutbound } from "afora-agent/plugin-sdk/text-chunking";
