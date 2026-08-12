// Whatsapp helper module owns direct participant delivery targets.
import {
  normalizeWhatsAppPhoneInput,
  parseExactWhatsAppJid,
  parseWhatsAppJid,
} from "./phone-input.js";

export function resolveWhatsAppProviderParticipantJid(
  value: string | null | undefined,
): string | undefined {
  const parsed = typeof value === "string" ? parseExactWhatsAppJid(value) : null;
  return parsed?.kind === "pn" || parsed?.kind === "lid" ? parsed.jid : undefined;
}

export function toWhatsAppParticipantJid(value: string): string {
  const parsed = parseWhatsAppJid(value);
  if (parsed?.kind === "pn" || parsed?.kind === "lid") {
    return parsed.jid;
  }
  const phone = normalizeWhatsAppPhoneInput(value);
  if (phone) {
    return `${phone.slice(1)}@s.whatsapp.net`;
  }
  throw new Error(
    "Invalid WhatsApp participant; use an E.164 phone number or a direct PN, hosted, LID, or hosted-LID JID.",
  );
}
