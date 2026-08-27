// Private runtime barrel for the bundled Google Chat extension.
// Keep this barrel thin and avoid broad plugin-sdk surfaces during bootstrap.

export { DEFAULT_ACCOUNT_ID } from "afora-agent/plugin-sdk/account-id";
export {
  createActionGate,
  jsonResult,
  readNumberParam,
  readReactionParams,
  readStringParam,
} from "afora-agent/plugin-sdk/channel-actions";
export { buildChannelConfigSchema, GoogleChatConfigSchema } from "./config-api.js";
export type {
  ChannelMessageActionAdapter,
  ChannelMessageActionName,
  ChannelStatusIssue,
} from "afora-agent/plugin-sdk/channel-contract";
export { missingTargetError } from "afora-agent/plugin-sdk/channel-feedback";
export {
  createAccountStatusSink,
  runPassiveAccountLifecycle,
} from "afora-agent/plugin-sdk/channel-outbound";
export { createChannelPairingController } from "afora-agent/plugin-sdk/channel-pairing";
export { createChannelMessageReplyPipeline } from "afora-agent/plugin-sdk/channel-outbound";
export { PAIRING_APPROVED_MESSAGE } from "afora-agent/plugin-sdk/channel-status";
export { chunkTextForOutbound } from "afora-agent/plugin-sdk/text-chunking";
export type { AforaConfig } from "afora-agent/plugin-sdk/config-contracts";
export {
  GROUP_POLICY_BLOCKED_LABEL,
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce,
} from "afora-agent/plugin-sdk/runtime-group-policy";
export { isDangerousNameMatchingEnabled } from "afora-agent/plugin-sdk/dangerous-name-runtime";
export type { PluginRuntime } from "afora-agent/plugin-sdk/runtime-store";
export { fetchWithSsrFGuard } from "afora-agent/plugin-sdk/ssrf-runtime";
export type {
  GoogleChatAccountConfig,
  GoogleChatConfig,
} from "afora-agent/plugin-sdk/config-contracts";
export { extractToolSend } from "afora-agent/plugin-sdk/tool-send";
export { resolveInboundMentionDecision } from "afora-agent/plugin-sdk/channel-inbound";
export { resolveWebhookPath } from "afora-agent/plugin-sdk/webhook-ingress";
export {
  registerWebhookTargetWithPluginRoute,
  resolveWebhookTargetWithAuthOrReject,
  withResolvedWebhookRequestPipeline,
} from "afora-agent/plugin-sdk/webhook-targets";
export {
  createWebhookInFlightLimiter,
  readJsonWebhookBodyOrReject,
  type WebhookInFlightLimiter,
} from "afora-agent/plugin-sdk/webhook-request-guards";
export { setGoogleChatRuntime } from "./src/runtime.js";
