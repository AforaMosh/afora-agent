// Qa Channel API module exposes the plugin public contract.
export type {
  ChannelMessageActionAdapter,
  ChannelMessageActionName,
  ChannelGatewayContext,
} from "afora-agent/plugin-sdk/channel-contract";
export type { ChannelPlugin } from "afora-agent/plugin-sdk/channel-core";
export type { AforaConfig } from "afora-agent/plugin-sdk/config-contracts";
export type { RuntimeEnv } from "afora-agent/plugin-sdk/runtime";
export type { PluginRuntime } from "afora-agent/plugin-sdk/runtime-store";
export {
  buildChannelConfigSchema,
  buildChannelOutboundSessionRoute,
  createChatChannelPlugin,
  defineChannelPluginEntry,
} from "afora-agent/plugin-sdk/channel-core";
export { jsonResult, readStringParam } from "afora-agent/plugin-sdk/channel-actions";
export { getChatChannelMeta } from "afora-agent/plugin-sdk/channel-plugin-common";
export {
  createComputedAccountStatusAdapter,
  createDefaultChannelRuntimeState,
} from "afora-agent/plugin-sdk/status-helpers";
export { createPluginRuntimeStore } from "afora-agent/plugin-sdk/runtime-store";
export { createChannelMessageReplyPipeline } from "afora-agent/plugin-sdk/channel-outbound";
