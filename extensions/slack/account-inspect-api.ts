// Slack API module exposes the plugin public contract.
import type { AforaConfig } from "afora-agent/plugin-sdk/config-contracts";
import { inspectSlackAccount } from "./src/account-inspect.js";

export function inspectSlackReadOnlyAccount(cfg: AforaConfig, accountId?: string | null) {
  return inspectSlackAccount({ cfg, accountId });
}
