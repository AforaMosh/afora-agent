// Private runtime barrel for the bundled Twitch extension.
// Keep this barrel thin and aligned with the local extension surface.

export type {
  ChannelAccountSnapshot,
  ChannelCapabilities,
  ChannelGatewayContext,
  ChannelLogSink,
  ChannelMessageActionAdapter,
  ChannelMessageActionContext,
  ChannelMeta,
  ChannelOutboundAdapter,
  ChannelOutboundContext,
  ChannelResolveKind,
  ChannelResolveResult,
  ChannelStatusAdapter,
} from "afora-agent/plugin-sdk/channel-contract";
export type { ChannelPlugin } from "afora-agent/plugin-sdk/channel-core";
export type { OutboundDeliveryResult } from "afora-agent/plugin-sdk/channel-send-result";
export type { AforaConfig } from "afora-agent/plugin-sdk/config-contracts";
export type { RuntimeEnv } from "afora-agent/plugin-sdk/runtime";
export type { WizardPrompter } from "afora-agent/plugin-sdk/setup";
