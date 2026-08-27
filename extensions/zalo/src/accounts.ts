// Zalo plugin module implements accounts behavior.
import { createAccountListHelpers } from "afora-agent/plugin-sdk/account-helpers";
import { normalizeAccountId } from "afora-agent/plugin-sdk/account-id";
import type { AforaConfig } from "afora-agent/plugin-sdk/config-contracts";
import { normalizeOptionalString } from "afora-agent/plugin-sdk/string-coerce-runtime";
import type { SecretInputStringResolutionMode } from "./secret-input.js";
import { resolveZaloToken } from "./token.js";
import type { ResolvedZaloAccount, ZaloAccountConfig, ZaloConfig } from "./types.js";

export type { ResolvedZaloAccount };

const {
  listAccountIds: listZaloAccountIds,
  resolveDefaultAccountId: resolveDefaultZaloAccountId,
  resolveAccountConfig: mergeZaloAccountConfig,
} = createAccountListHelpers<ZaloAccountConfig>("zalo", {
  omitKeys: ["defaultAccount"],
  implicitDefaultAccount: {
    channelKeys: ["botToken", "tokenFile"],
    envVars: ["ZALO_BOT_TOKEN"],
  },
});
export { listZaloAccountIds, resolveDefaultZaloAccountId };

function resolveZaloAccountWithMode(params: {
  cfg: AforaConfig;
  accountId?: string | null;
  mode: SecretInputStringResolutionMode;
}): ResolvedZaloAccount {
  const accountId = normalizeAccountId(
    params.accountId ?? (params.cfg.channels?.zalo as ZaloConfig | undefined)?.defaultAccount,
  );
  const baseEnabled = (params.cfg.channels?.zalo as ZaloConfig | undefined)?.enabled !== false;
  const merged = mergeZaloAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;
  const tokenResolution = resolveZaloToken(
    params.cfg.channels?.zalo as ZaloConfig | undefined,
    accountId,
    { mode: params.mode },
  );

  return {
    accountId,
    name: normalizeOptionalString(merged.name),
    enabled,
    token: tokenResolution.token,
    tokenSource: tokenResolution.source,
    tokenStatus: tokenResolution.status,
    config: merged,
  };
}

export function resolveZaloAccount(params: {
  cfg: AforaConfig;
  accountId?: string | null;
}): ResolvedZaloAccount {
  return resolveZaloAccountWithMode({ ...params, mode: "strict" });
}

export function inspectZaloAccount(params: {
  cfg: AforaConfig;
  accountId?: string | null;
}): ResolvedZaloAccount {
  return resolveZaloAccountWithMode({ ...params, mode: "inspect" });
}
