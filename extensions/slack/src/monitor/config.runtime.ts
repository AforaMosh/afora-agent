// Slack helper module supports config behavior.
export { getRuntimeConfig } from "afora-agent/plugin-sdk/runtime-config-snapshot";
export { isDangerousNameMatchingEnabled } from "afora-agent/plugin-sdk/dangerous-name-runtime";
export {
  readSessionUpdatedAt,
  resolveChannelResetConfig,
  resolveStorePath,
  updateLastRoute,
} from "afora-agent/plugin-sdk/session-store-runtime";
export { resolveChannelContextVisibilityMode } from "afora-agent/plugin-sdk/context-visibility-runtime";
export {
  resolveDefaultGroupPolicy,
  resolveOpenProviderRuntimeGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce,
} from "afora-agent/plugin-sdk/runtime-group-policy";
