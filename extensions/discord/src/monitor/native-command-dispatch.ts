// Discord plugin module implements native command dispatch behavior.
import type { ChatCommandDefinition, CommandArgs } from "afora-agent/plugin-sdk/command-auth-native";
import type { AforaConfig } from "afora-agent/plugin-sdk/config-contracts";
import type { PluginCommandCatalogDecision } from "afora-agent/plugin-sdk/plugin-command-runtime";
import type { ReplyPayload } from "afora-agent/plugin-sdk/reply-dispatch-runtime";
import type { ResolvedAgentRoute } from "afora-agent/plugin-sdk/routing";
import type {
  ButtonInteraction,
  CommandInteraction,
  StringSelectMenuInteraction,
} from "../internal/discord.js";
import type { ThreadBindingManager } from "./thread-bindings.js";

type DiscordConfig = NonNullable<AforaConfig["channels"]>["discord"];

type DispatchDiscordCommandInteractionParams = {
  interaction: CommandInteraction | ButtonInteraction | StringSelectMenuInteraction;
  prompt: string;
  command: ChatCommandDefinition;
  commandArgs?: CommandArgs;
  cfg: AforaConfig;
  discordConfig: DiscordConfig;
  accountId: string;
  sessionPrefix: string;
  preferFollowUp: boolean;
  threadBindings: ThreadBindingManager;
  responseEphemeral?: boolean;
  suppressReplies?: boolean;
  pluginCommandDispatch: PluginCommandCatalogDecision;
};

export type DispatchDiscordCommandInteractionResult = {
  accepted: boolean;
  effectiveRoute?: ResolvedAgentRoute;
  hiddenFinalReply?: ReplyPayload;
};

export type DispatchDiscordCommandInteraction = (
  params: DispatchDiscordCommandInteractionParams,
) => Promise<DispatchDiscordCommandInteractionResult>;
