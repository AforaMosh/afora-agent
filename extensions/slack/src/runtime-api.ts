// Slack API module exposes the plugin public contract.
export {
  buildComputedAccountStatusSnapshot,
  PAIRING_APPROVED_MESSAGE,
  projectCredentialSnapshotFields,
  resolveConfiguredFromRequiredCredentialStatuses,
} from "afora-agent/plugin-sdk/channel-status";
export { buildChannelConfigSchema, SlackConfigSchema } from "../config-api.js";
export type { ChannelMessageActionContext } from "afora-agent/plugin-sdk/channel-contract";
export { DEFAULT_ACCOUNT_ID } from "afora-agent/plugin-sdk/account-id";
export type {
  ChannelPlugin,
  AforaPluginApi,
  PluginRuntime,
} from "afora-agent/plugin-sdk/channel-plugin-common";
export type { AforaConfig } from "afora-agent/plugin-sdk/config-contracts";
export type { SlackAccountConfig } from "afora-agent/plugin-sdk/config-contracts";
export {
  emptyPluginConfigSchema,
  formatPairingApproveHint,
} from "afora-agent/plugin-sdk/channel-plugin-common";
export { loadOutboundMediaFromUrl } from "afora-agent/plugin-sdk/outbound-media";
export { looksLikeSlackTargetId, normalizeSlackMessagingTarget } from "./target-parsing.js";
export { getChatChannelMeta } from "./channel-api.js";
export {
  createActionGate,
  imageResultFromFile,
  jsonResult,
  readNumberParam,
  readPositiveIntegerParam,
  readReactionParams,
  readStringParam,
  withNormalizedTimestamp,
} from "afora-agent/plugin-sdk/channel-actions";
