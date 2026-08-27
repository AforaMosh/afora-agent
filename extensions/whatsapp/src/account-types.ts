// Whatsapp plugin module implements account types behavior.
import type { AforaConfig } from "afora-agent/plugin-sdk/config-contracts";

export type WhatsAppAccountConfig = NonNullable<
  NonNullable<NonNullable<AforaConfig["channels"]>["whatsapp"]>["accounts"]
>[string];
