// Matrix API module exposes the plugin public contract.
export {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  normalizeOptionalAccountId,
} from "afora-agent/plugin-sdk/account-id";
export {
  createActionGate,
  jsonResult,
  readNumberParam,
  readPositiveIntegerParam,
  readReactionParams,
  readStringArrayParam,
  readStringParam,
  ToolAuthorizationError,
} from "afora-agent/plugin-sdk/channel-actions";
export { buildChannelConfigSchema } from "afora-agent/plugin-sdk/channel-config-schema";
export type { ChannelPlugin } from "afora-agent/plugin-sdk/channel-core";
export type {
  BaseProbeResult,
  ChannelDirectoryEntry,
  ChannelGroupContext,
  ChannelMessageActionAdapter,
  ChannelMessageActionContext,
  ChannelMessageActionName,
  ChannelMessageToolDiscovery,
  ChannelOutboundAdapter,
  ChannelResolveKind,
  ChannelResolveResult,
  ChannelToolSend,
} from "afora-agent/plugin-sdk/channel-contract";
export {
  formatLocationText,
  toLocationContext,
  type NormalizedLocation,
} from "afora-agent/plugin-sdk/channel-inbound";
export { logInboundDrop } from "afora-agent/plugin-sdk/channel-inbound";
export { logTypingFailure } from "afora-agent/plugin-sdk/channel-outbound";
export { resolveAckReaction } from "afora-agent/plugin-sdk/channel-feedback";
export type { ChannelSetupInput } from "afora-agent/plugin-sdk/setup";
export type {
  AforaConfig,
  ContextVisibilityMode,
  DmPolicy,
  GroupPolicy,
} from "afora-agent/plugin-sdk/config-contracts";
export type { GroupToolPolicyConfig } from "afora-agent/plugin-sdk/config-contracts";
export type { WizardPrompter } from "afora-agent/plugin-sdk/setup";
export type { SecretInput } from "afora-agent/plugin-sdk/secret-input";
export {
  GROUP_POLICY_BLOCKED_LABEL,
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce,
} from "afora-agent/plugin-sdk/runtime-group-policy";
export {
  addWildcardAllowFrom,
  formatDocsLink,
  hasConfiguredSecretInput,
  mergeAllowFromEntries,
  moveSingleAccountChannelSectionToDefaultAccount,
  promptAccountId,
  promptChannelAccessConfig,
  splitSetupEntries,
} from "afora-agent/plugin-sdk/setup";
export type { RuntimeEnv } from "afora-agent/plugin-sdk/runtime";
export {
  assertHttpUrlTargetsPrivateNetwork,
  closeDispatcher,
  createPinnedDispatcher,
  isPrivateOrLoopbackHost,
  resolvePinnedHostnameWithPolicy,
  ssrfPolicyFromDangerouslyAllowPrivateNetwork,
  type LookupFn,
  type SsrFPolicy,
} from "afora-agent/plugin-sdk/ssrf-runtime";
export {
  ensureConfiguredAcpBindingReady,
  resolveConfiguredAcpBindingRecord,
} from "afora-agent/plugin-sdk/acp-binding-runtime";
export {
  buildProbeChannelStatusSummary,
  collectStatusIssuesFromLastError,
  PAIRING_APPROVED_MESSAGE,
} from "afora-agent/plugin-sdk/channel-status";
export {
  getSessionBindingService,
  resolveThreadBindingIdleTimeoutMsForChannel,
  resolveThreadBindingMaxAgeMsForChannel,
} from "afora-agent/plugin-sdk/conversation-runtime";
export { resolveOutboundSendDep } from "afora-agent/plugin-sdk/channel-outbound";
export { resolveAgentIdFromSessionKey } from "afora-agent/plugin-sdk/routing";
export { chunkTextForOutbound } from "afora-agent/plugin-sdk/text-chunking";
export { createChannelMessageReplyPipeline } from "afora-agent/plugin-sdk/channel-outbound";
export { loadOutboundMediaFromUrl } from "afora-agent/plugin-sdk/outbound-media";
export { normalizePollInput, type PollInput } from "afora-agent/plugin-sdk/poll-runtime";
export { writeJsonFileAtomically } from "afora-agent/plugin-sdk/json-store";
export {
  buildChannelKeyCandidates,
  resolveChannelEntryMatch,
} from "afora-agent/plugin-sdk/channel-targets";
export { buildTimeoutAbortSignal } from "./matrix/sdk/timeout-abort-signal.js";
export { formatZonedTimestamp } from "afora-agent/plugin-sdk/time-runtime";
export type { PluginRuntime, RuntimeLogger } from "afora-agent/plugin-sdk/plugin-runtime";
export type { ReplyPayload } from "afora-agent/plugin-sdk/reply-runtime";
// resolveMatrixAccountStringValues already comes from the Matrix API barrel.
// Re-exporting auth-precedence here makes TS source loaders define the export twice.
