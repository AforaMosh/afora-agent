// Whatsapp plugin module implements channel actions behavior.
import { createActionGate } from "afora-agent/plugin-sdk/channel-actions";
import type { ChannelMessageActionName } from "afora-agent/plugin-sdk/channel-contract";
import type { AforaConfig } from "afora-agent/plugin-sdk/config-contracts";

export { listWhatsAppAccountIds, resolveWhatsAppAccount } from "./accounts.js";
export { resolveWhatsAppReactionLevel } from "./reaction-level.js";
export { createActionGate, type ChannelMessageActionName, type AforaConfig };
