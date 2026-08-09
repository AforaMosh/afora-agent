// Discord type declarations define plugin contracts.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { DiscordInboundRuntimeResolver } from "./inbound-runtime.js";
import type { ThreadBindingManager } from "./thread-bindings.js";

type DiscordConfig = NonNullable<OpenClawConfig["channels"]>["discord"];

export type DiscordCommandArgContext = {
  cfg: OpenClawConfig;
  discordConfig: DiscordConfig;
  accountId: string;
  sessionPrefix: string;
  threadBindings: ThreadBindingManager;
  /** Each deferred control resolves its own facade when the user clicks it. */
  inbound: DiscordInboundRuntimeResolver;
  postApplySettleMs?: number;
};

export type DiscordModelPickerContext = DiscordCommandArgContext;

export type SafeDiscordInteractionCall = <T>(
  label: string,
  fn: () => Promise<T>,
) => Promise<T | null>;
