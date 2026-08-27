// Telegram API module exposes the plugin public contract.
import type { AforaConfig } from "./runtime-api.js";
import { inspectTelegramAccount } from "./src/account-inspect.js";

export function inspectTelegramReadOnlyAccount(cfg: AforaConfig, accountId?: string | null) {
  return inspectTelegramAccount({ cfg, accountId });
}
