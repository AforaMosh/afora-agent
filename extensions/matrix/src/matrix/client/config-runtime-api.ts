// Matrix API module exposes the plugin public contract.
export {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  normalizeOptionalAccountId,
} from "afora-agent/plugin-sdk/account-id";
export {
  isPrivateNetworkOptInEnabled,
  ssrfPolicyFromDangerouslyAllowPrivateNetwork,
} from "afora-agent/plugin-sdk/ssrf-runtime";
