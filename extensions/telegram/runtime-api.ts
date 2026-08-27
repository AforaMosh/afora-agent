// Telegram API module exposes the plugin public contract.
import type { AforaConfig as RuntimeAforaConfig } from "afora-agent/plugin-sdk/config-contracts";
export type { AforaPluginApi } from "afora-agent/plugin-sdk/plugin-entry";
export type { ChannelMessageActionAdapter } from "afora-agent/plugin-sdk/channel-contract";
export type { TelegramApiOverride } from "./src/send.js";
export type {
  AforaPluginService,
  AforaPluginServiceContext,
  PluginLogger,
} from "afora-agent/plugin-sdk/plugin-entry";
export type { PluginRuntime } from "afora-agent/plugin-sdk/runtime-store";
export type {
  AcpRuntime,
  AcpRuntimeCapabilities,
  AcpRuntimeDoctorReport,
  AcpRuntimeEnsureInput,
  AcpRuntimeEvent,
  AcpRuntimeHandle,
  AcpRuntimeStatus,
  AcpRuntimeTurnInput,
  AcpRuntimeErrorCode,
  AcpSessionUpdateTag,
} from "afora-agent/plugin-sdk/acp-runtime";
export { AcpRuntimeError } from "afora-agent/plugin-sdk/acp-runtime";

export {
  emptyPluginConfigSchema,
  formatPairingApproveHint,
  getChatChannelMeta,
} from "afora-agent/plugin-sdk/channel-plugin-common";
export { clearAccountEntryFields } from "afora-agent/plugin-sdk/channel-core";
export { buildChannelConfigSchema, TelegramConfigSchema } from "./config-api.js";
export { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "afora-agent/plugin-sdk/account-id";
export {
  PAIRING_APPROVED_MESSAGE,
  buildTokenChannelStatusSummary,
  projectCredentialSnapshotFields,
  resolveConfiguredFromCredentialStatuses,
} from "afora-agent/plugin-sdk/channel-status";
export {
  jsonResult,
  readNumberParam,
  readReactionParams,
  readStringArrayParam,
  readStringOrNumberParam,
  readStringParam,
  resolvePollMaxSelections,
} from "afora-agent/plugin-sdk/channel-actions";
export type { TelegramProbe } from "./src/probe.js";
export { auditTelegramGroupMembership, collectTelegramUnmentionedGroupIds } from "./src/audit.js";
export { resolveTelegramRuntimeGroupPolicy } from "./src/group-access.js";
export {
  buildTelegramExecApprovalPendingPayload,
  shouldSuppressTelegramExecApprovalForwardingFallback,
} from "./src/exec-approval-forwarding.js";
export { telegramMessageActions } from "./src/channel-actions.js";
export { monitorTelegramProvider } from "./src/monitor.js";
export { probeTelegram } from "./src/probe.js";
export {
  resolveTelegramFetch,
  resolveTelegramTransport,
  shouldRetryTelegramTransportFallback,
} from "./src/fetch.js";
export { makeProxyFetch } from "./src/proxy.js";
export {
  createForumTopicTelegram,
  deleteMessageTelegram,
  editForumTopicTelegram,
  editMessageReplyMarkupTelegram,
  editMessageTelegram,
  pinMessageTelegram,
  reactMessageTelegram,
  renameForumTopicTelegram,
  sendMessageTelegram,
  sendPollTelegram,
  sendStickerTelegram,
  sendTypingTelegram,
  unpinMessageTelegram,
} from "./src/send.js";
export {
  createTelegramThreadBindingManager,
  getTelegramThreadBindingManager,
  setTelegramThreadBindingIdleTimeoutBySessionKey,
  setTelegramThreadBindingMaxAgeBySessionKey,
} from "./src/thread-bindings.js";
export { resolveTelegramToken } from "./src/token.js";
export { setTelegramRuntime } from "./src/runtime.js";
export type { ChannelPlugin } from "afora-agent/plugin-sdk/channel-core";
export type { AforaConfig } from "afora-agent/plugin-sdk/config-contracts";
export type TelegramAccountConfig = NonNullable<
  NonNullable<RuntimeAforaConfig["channels"]>["telegram"]
>;
export type TelegramActionConfig = NonNullable<TelegramAccountConfig["actions"]>;
export type TelegramNetworkConfig = NonNullable<TelegramAccountConfig["network"]>;
export { parseTelegramTopicConversation } from "./src/topic-conversation.js";
export { resolveTelegramPollVisibility } from "./src/poll-visibility.js";
