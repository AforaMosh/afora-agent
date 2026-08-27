// Line API module exposes the plugin public contract.
import { DEFAULT_ACCOUNT_ID } from "afora-agent/plugin-sdk/account-id";
import type { AforaConfig } from "afora-agent/plugin-sdk/account-resolution";
import type { ChannelPlugin } from "afora-agent/plugin-sdk/core";
import { listLineAccountIds, resolveDefaultLineAccountId, resolveLineAccount } from "./accounts.js";
import { resolveExactLineGroupConfigKey } from "./group-keys.js";
import type { LineConfig, ResolvedLineAccount } from "./types.js";
export { clearAccountEntryFields } from "afora-agent/plugin-sdk/core";

export {
  DEFAULT_ACCOUNT_ID,
  listLineAccountIds,
  resolveDefaultLineAccountId,
  resolveExactLineGroupConfigKey,
  resolveLineAccount,
};

export type { ChannelPlugin, LineConfig, AforaConfig, ResolvedLineAccount };
