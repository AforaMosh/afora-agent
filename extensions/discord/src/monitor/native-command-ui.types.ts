// Discord type declarations define plugin contracts.
import type { AforaConfig } from "afora-agent/plugin-sdk/config-contracts";
import type { ThreadBindingManager } from "./thread-bindings.js";

type DiscordConfig = NonNullable<AforaConfig["channels"]>["discord"];

export type DiscordCommandArgContext = {
  cfg: AforaConfig;
  discordConfig: DiscordConfig;
  accountId: string;
  sessionPrefix: string;
  threadBindings: ThreadBindingManager;
  postApplySettleMs?: number;
};

export type DiscordModelPickerContext = DiscordCommandArgContext;

export type SafeDiscordInteractionCall = <T>(
  label: string,
  fn: () => Promise<T>,
) => Promise<T | null>;
