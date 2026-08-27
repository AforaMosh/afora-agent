// Whatsapp plugin module implements text runtime behavior.
export {
  sanitizeAssistantVisibleText,
  sanitizeAssistantVisibleTextWithProfile,
  stripToolCallXmlTags,
} from "afora-agent/plugin-sdk/text-chunking";
export { normalizeE164, resolveUserPath } from "afora-agent/plugin-sdk/text-utility-runtime";
export {
  assertWebChannel,
  isSelfChatMode,
  jidToE164,
  markdownToWhatsApp,
  markdownToWhatsAppChunks,
  resolveEquivalentWhatsAppDirectChatJids,
  resolveJidToE164,
  toWhatsappJid,
  toWhatsappJidWithLid,
  type JidToE164Options,
  type WebChannel,
} from "./targets-runtime.js";
