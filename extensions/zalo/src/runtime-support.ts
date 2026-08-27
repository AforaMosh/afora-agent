// Zalo plugin module implements runtime support behavior.
export type { ReplyPayload } from "afora-agent/plugin-sdk/reply-runtime";
export type { AforaConfig, GroupPolicy } from "afora-agent/plugin-sdk/config-contracts";
export type { MarkdownTableMode } from "afora-agent/plugin-sdk/config-contracts";
export type { BaseTokenResolution } from "afora-agent/plugin-sdk/channel-contract";
export type {
  BaseProbeResult,
  ChannelAccountSnapshot,
  ChannelMessageActionAdapter,
  ChannelMessageActionName,
  ChannelStatusIssue,
} from "afora-agent/plugin-sdk/channel-contract";
export type { SecretInput } from "afora-agent/plugin-sdk/secret-input";
export type { ChannelPlugin, PluginRuntime, WizardPrompter } from "afora-agent/plugin-sdk/core";
export type { RuntimeEnv } from "afora-agent/plugin-sdk/runtime";
export type { OutboundReplyPayload } from "afora-agent/plugin-sdk/reply-payload";
export {
  DEFAULT_ACCOUNT_ID,
  buildChannelConfigSchema,
  createDedupeCache,
  formatPairingApproveHint,
  jsonResult,
  normalizeAccountId,
  readStringParam,
  resolveClientIp,
} from "afora-agent/plugin-sdk/core";
export {
  applyAccountNameToChannelSection,
  applySetupAccountConfigPatch,
  buildSingleChannelSecretPromptState,
  mergeAllowFromEntries,
  migrateBaseNameToDefaultAccount,
  promptSingleChannelSecretInput,
  runSingleChannelSecretStep,
  setTopLevelChannelDmPolicyWithAllowFrom,
} from "afora-agent/plugin-sdk/setup";
export {
  buildSecretInputSchema,
  hasConfiguredSecretInput,
  normalizeResolvedSecretInputString,
  normalizeSecretInputString,
} from "afora-agent/plugin-sdk/secret-input";
export {
  buildTokenChannelStatusSummary,
  PAIRING_APPROVED_MESSAGE,
} from "afora-agent/plugin-sdk/channel-status";
export { buildBaseAccountStatusSnapshot } from "afora-agent/plugin-sdk/status-helpers";
export { chunkTextForOutbound } from "afora-agent/plugin-sdk/text-chunking";
export {
  formatAllowFromLowercase,
  isNormalizedSenderAllowed,
} from "afora-agent/plugin-sdk/allow-from";
export { addWildcardAllowFrom } from "afora-agent/plugin-sdk/setup";
export { resolveOpenProviderRuntimeGroupPolicy } from "afora-agent/plugin-sdk/runtime-group-policy";
export {
  warnMissingProviderGroupPolicyFallbackOnce,
  resolveDefaultGroupPolicy,
} from "afora-agent/plugin-sdk/runtime-group-policy";
export { createChannelPairingController } from "afora-agent/plugin-sdk/channel-pairing";
export { createChannelMessageReplyPipeline } from "afora-agent/plugin-sdk/channel-outbound";
export { logTypingFailure } from "afora-agent/plugin-sdk/channel-feedback";
export {
  deliverTextOrMediaReply,
  isNumericTargetId,
  sendPayloadWithChunkedTextAndMedia,
} from "afora-agent/plugin-sdk/reply-payload";
export { waitForAbortSignal } from "afora-agent/plugin-sdk/runtime";
export {
  applyBasicWebhookRequestGuards,
  createFixedWindowRateLimiter,
  createWebhookAnomalyTracker,
  readJsonWebhookBodyOrReject,
  registerPluginHttpRoute,
  registerWebhookTarget,
  registerWebhookTargetWithPluginRoute,
  resolveWebhookPath,
  resolveWebhookTargetWithAuthOrRejectSync,
  WEBHOOK_ANOMALY_COUNTER_DEFAULTS,
  WEBHOOK_RATE_LIMIT_DEFAULTS,
  withResolvedWebhookRequestPipeline,
} from "afora-agent/plugin-sdk/webhook-ingress";
export type {
  RegisterWebhookPluginRouteOptions,
  RegisterWebhookTargetOptions,
} from "afora-agent/plugin-sdk/webhook-ingress";
