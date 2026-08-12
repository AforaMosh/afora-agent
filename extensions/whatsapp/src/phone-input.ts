// Whatsapp helper module owns dependency-free strict phone input parsing.
const WHATSAPP_PHONE_INPUT_RE = /^\+?[\d ().-]+$/;

export function stripWhatsAppTargetPrefixes(value: string): string {
  let candidate = value.replace(/^ +| +$/g, "");
  while (/^whatsapp:/i.test(candidate)) {
    candidate = candidate.replace(/^whatsapp:/i, "").replace(/^ +| +$/g, "");
  }
  return candidate;
}

export function normalizeWhatsAppPhoneInput(value: string): string | null {
  const candidate = stripWhatsAppTargetPrefixes(value);
  const digits = WHATSAPP_PHONE_INPUT_RE.test(candidate) ? candidate.replace(/\D/g, "") : "";
  return digits ? `+${digits}` : null;
}
