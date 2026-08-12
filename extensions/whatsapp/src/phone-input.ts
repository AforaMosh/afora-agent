// Whatsapp helper module owns dependency-free strict phone input parsing.
const WHATSAPP_PHONE_INPUT_RE = /^\+?[\d ().-]+$/;
const WHATSAPP_JID_PATTERNS = [
  ["pn", /^(\d+)(?::(\d+))?@(s\.whatsapp\.net|hosted)$/i],
  ["pn", /^(\d+)()@(c\.us)$/i],
  ["lid", /^(\d+)(?::(\d+))?@(lid|hosted\.lid)$/i],
  ["group", /^([0-9]+(?:-[0-9]+)*)()@(g\.us)$/i],
  ["newsletter", /^([0-9]+)()@(newsletter)$/i],
] as const;

type ParsedWhatsAppJid = {
  kind: "pn" | "lid" | "group" | "newsletter";
  jid: string;
  digits: string;
  domain: string;
};

export function trimWhatsAppAsciiSpaces(value: string): string {
  return value.replace(/^ +| +$/g, "");
}

export function hasUnsafeWhatsAppTargetCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return (
      codePoint <= 0x1f || codePoint === 0x7f || (character !== " " && character.trim() === "")
    );
  });
}

export function stripWhatsAppTargetPrefixes(value: string): string {
  let candidate = trimWhatsAppAsciiSpaces(value);
  while (/^whatsapp:/i.test(candidate)) {
    candidate = trimWhatsAppAsciiSpaces(candidate.replace(/^whatsapp:/i, ""));
  }
  return candidate;
}

export function parseExactWhatsAppJid(value: string): ParsedWhatsAppJid | null {
  if (hasUnsafeWhatsAppTargetCharacters(value)) {
    return null;
  }
  for (const [kind, pattern] of WHATSAPP_JID_PATTERNS) {
    const match = value.match(pattern);
    const digits = match?.[1];
    const domain = match?.[3]?.toLowerCase();
    if (!digits || !domain) {
      continue;
    }
    const device = match?.[2] ? `:${match[2]}` : "";
    return { kind, jid: `${digits}${device}@${domain}`, digits, domain };
  }
  return null;
}

export function parseWhatsAppJid(value: string): ParsedWhatsAppJid | null {
  const stripped = stripWhatsAppTargetPrefixes(value);
  const hasGroupPrefix = /^group:/i.test(stripped);
  const candidate = trimWhatsAppAsciiSpaces(stripped.replace(/^group:/i, ""));
  const parsed = parseExactWhatsAppJid(candidate);
  return hasGroupPrefix && parsed?.kind !== "group" ? null : parsed;
}

export function normalizeWhatsAppPhoneInput(value: string): string | null {
  if (hasUnsafeWhatsAppTargetCharacters(value)) {
    return null;
  }
  const candidate = stripWhatsAppTargetPrefixes(value);
  const digits = WHATSAPP_PHONE_INPUT_RE.test(candidate) ? candidate.replace(/\D/g, "") : "";
  return digits ? `+${digits}` : null;
}
