// Discord API module exposes the plugin public contract.
export {
  buildComputedAccountStatusSnapshot,
  buildTokenChannelStatusSummary,
  PAIRING_APPROVED_MESSAGE,
  projectCredentialSnapshotFields,
  resolveConfiguredFromCredentialStatuses,
} from "afora-agent/plugin-sdk/channel-status";
export { buildChannelConfigSchema, DiscordConfigSchema } from "../config-api.js";
export type {
  ChannelMessageActionAdapter,
  ChannelMessageActionContext,
  ChannelMessageActionName,
} from "afora-agent/plugin-sdk/channel-contract";
export type {
  ChannelPlugin,
  AforaPluginApi,
  PluginRuntime,
} from "afora-agent/plugin-sdk/channel-plugin-common";
export type {
  DiscordAccountConfig,
  DiscordActionConfig,
  DiscordConfig,
  AforaConfig,
} from "afora-agent/plugin-sdk/config-contracts";
export {
  jsonResult,
  readNonNegativeIntegerParam,
  readNumberParam,
  readPositiveIntegerParam,
  readStringArrayParam,
  readStringParam,
  resolvePollMaxSelections,
} from "afora-agent/plugin-sdk/channel-actions";
export type { ActionGate } from "afora-agent/plugin-sdk/channel-actions";
export { readBooleanParam } from "afora-agent/plugin-sdk/boolean-param";
export {
  assertMediaNotDataUrl,
  parseAvailableTags,
  readReactionParams,
  withNormalizedTimestamp,
} from "afora-agent/plugin-sdk/channel-actions";
export {
  createHybridChannelConfigAdapter,
  createScopedChannelConfigAdapter,
  createScopedAccountConfigAccessors,
  createScopedChannelConfigBase,
  createTopLevelChannelConfigAdapter,
} from "afora-agent/plugin-sdk/channel-config-helpers";
export {
  createAccountActionGate,
  createAccountListHelpers,
} from "afora-agent/plugin-sdk/account-helpers";
export { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "afora-agent/plugin-sdk/account-id";
export {
  emptyPluginConfigSchema,
  formatPairingApproveHint,
} from "afora-agent/plugin-sdk/channel-plugin-common";
export { loadOutboundMediaFromUrl } from "afora-agent/plugin-sdk/outbound-media";
export { resolveAccountEntry } from "afora-agent/plugin-sdk/routing";
export {
  hasConfiguredSecretInput,
  normalizeResolvedSecretInputString,
  normalizeSecretInputString,
} from "afora-agent/plugin-sdk/secret-input";
export { getChatChannelMeta } from "./channel-api.js";
export { resolveDiscordOutboundSessionRoute } from "./outbound-session-route.js";
