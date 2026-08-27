// Private runtime barrel for the bundled Nextcloud Talk extension.
// Keep this barrel thin and aligned with the local extension surface.

export type { AllowlistMatch } from "afora-agent/plugin-sdk/allow-from";
export type { ChannelGroupContext } from "afora-agent/plugin-sdk/channel-contract";
export { logInboundDrop } from "afora-agent/plugin-sdk/channel-inbound";
export { createChannelPairingController } from "afora-agent/plugin-sdk/channel-pairing";
export type {
  BlockStreamingCoalesceConfig,
  DmConfig,
  DmPolicy,
  GroupPolicy,
  GroupToolPolicyConfig,
  AforaConfig,
} from "afora-agent/plugin-sdk/config-contracts";
export {
  GROUP_POLICY_BLOCKED_LABEL,
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce,
} from "afora-agent/plugin-sdk/runtime-group-policy";
export { createChannelMessageReplyPipeline } from "afora-agent/plugin-sdk/channel-outbound";
export type { OutboundReplyPayload } from "afora-agent/plugin-sdk/reply-payload";
export { deliverFormattedTextWithAttachments } from "afora-agent/plugin-sdk/reply-payload";
export type { PluginRuntime } from "afora-agent/plugin-sdk/runtime-store";
export type { RuntimeEnv } from "afora-agent/plugin-sdk/runtime";
export type { SecretInput } from "afora-agent/plugin-sdk/secret-input";
export { fetchWithSsrFGuard } from "afora-agent/plugin-sdk/ssrf-runtime";
export { setNextcloudTalkRuntime } from "./src/runtime.js";
