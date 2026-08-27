// Imessage plugin module implements account types behavior.
import type { AforaConfig } from "afora-agent/plugin-sdk/config-contracts";

export type IMessageAccountConfig = Omit<
  NonNullable<NonNullable<AforaConfig["channels"]>["imessage"]>,
  "accounts" | "defaultAccount"
>;
