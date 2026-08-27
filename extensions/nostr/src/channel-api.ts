// Nostr API module exposes the plugin public contract.
export {
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  formatPairingApproveHint,
  type ChannelPlugin,
} from "afora-agent/plugin-sdk/channel-plugin-common";
export type { ChannelOutboundAdapter } from "afora-agent/plugin-sdk/channel-contract";
export {
  collectStatusIssuesFromLastError,
  createDefaultChannelRuntimeState,
} from "afora-agent/plugin-sdk/status-helpers";
