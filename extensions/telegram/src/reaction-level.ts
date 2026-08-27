// Telegram plugin module implements reaction level behavior.
import type { AforaConfig } from "afora-agent/plugin-sdk/config-contracts";
import {
  resolveReactionLevel,
  type ReactionLevel,
  type ResolvedReactionLevel as BaseResolvedReactionLevel,
} from "afora-agent/plugin-sdk/status-helpers";
import { inspectTelegramAccount } from "./account-inspect.js";

export type TelegramReactionLevel = ReactionLevel;
export type ResolvedReactionLevel = BaseResolvedReactionLevel;

/**
 * Resolve the effective reaction level and its implications.
 */
export function resolveTelegramReactionLevel(params: {
  cfg: AforaConfig;
  accountId?: string;
}): ResolvedReactionLevel {
  const account = inspectTelegramAccount({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  return resolveReactionLevel({
    value: account.config.reactionLevel,
    defaultLevel: "minimal",
    invalidFallback: "ack",
  });
}
