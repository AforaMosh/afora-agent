// Mattermost plugin module implements secret input behavior.
export type { SecretInput } from "afora-agent/plugin-sdk/secret-input";
export {
  buildSecretInputSchema,
  hasConfiguredSecretInput,
  resolveSecretInputString,
} from "afora-agent/plugin-sdk/secret-input";
export type { SecretInputStringResolutionMode } from "afora-agent/plugin-sdk/secret-input";
