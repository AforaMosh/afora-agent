// Discord API module exposes the plugin public contract.
import type { AforaConfig } from "afora-agent/plugin-sdk/config-contracts";
import { inspectDiscordAccount } from "./src/account-inspect.js";

export function inspectDiscordReadOnlyAccount(cfg: AforaConfig, accountId?: string | null) {
  return inspectDiscordAccount({ cfg, accountId });
}
