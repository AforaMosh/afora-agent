// Whatsapp plugin module implements channel react action behavior.
import { readStringOrNumberParam, readStringParam } from "afora-agent/plugin-sdk/channel-actions";
import type { AforaConfig } from "afora-agent/plugin-sdk/config-contracts";

export { resolveReactionMessageId } from "afora-agent/plugin-sdk/channel-actions";
export { handleWhatsAppAction } from "./action-runtime.js";
export { resolveAuthorizedWhatsAppOutboundTarget } from "./action-runtime-target-auth.js";
export { resolveWhatsAppAccount, resolveWhatsAppMediaMaxBytes } from "./accounts.js";
export { isWhatsAppGroupJid, normalizeWhatsAppTarget } from "./normalize.js";
export { sendMessageWhatsApp } from "./send.js";
export { readStringOrNumberParam, readStringParam, type AforaConfig };
