// Discord type declarations define plugin contracts.
import type { AforaConfig } from "afora-agent/plugin-sdk/config-contracts";
import type { CommandArgValues } from "afora-agent/plugin-sdk/native-command-registry";

export type DiscordConfig = NonNullable<AforaConfig["channels"]>["discord"];

export type DiscordCommandArgs = {
  raw?: string;
  values?: CommandArgValues;
};
