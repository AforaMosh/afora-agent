// Whatsapp helper module supports normalize target behavior.
import { uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  hasUnsafeWhatsAppTargetCharacters,
  normalizeWhatsAppPhoneInput,
  parseWhatsAppJid,
  stripWhatsAppTargetPrefixes,
  trimWhatsAppAsciiSpaces,
} from "./phone-input.js";

function normalizeWhatsAppGroupJid(value: string): string | null {
  const parsed = parseWhatsAppJid(value);
  return parsed?.kind === "group" ? parsed.jid : null;
}

export function isWhatsAppGroupJid(value: string): boolean {
  return normalizeWhatsAppGroupJid(value) !== null;
}

export function isWhatsAppNewsletterJid(value: string): boolean {
  return parseWhatsAppJid(value)?.kind === "newsletter";
}

export function isWhatsAppUserTarget(value: string): boolean {
  const kind = parseWhatsAppJid(value)?.kind;
  return kind === "pn" || kind === "lid";
}

export function normalizeWhatsAppTarget(value: string): string | null {
  if (hasUnsafeWhatsAppTargetCharacters(value)) {
    return null;
  }
  const candidate = stripWhatsAppTargetPrefixes(value);
  if (!candidate) {
    return null;
  }
  const parsed = parseWhatsAppJid(candidate);
  if (parsed?.kind === "group" || parsed?.kind === "newsletter") {
    return parsed.jid;
  }
  if (parsed?.kind === "lid") {
    return `${parsed.digits}@${parsed.domain}`;
  }
  if (parsed?.kind === "pn") {
    return normalizeWhatsAppPhoneInput(parsed.digits);
  }
  if (candidate.includes("@")) {
    return null;
  }
  return normalizeWhatsAppPhoneInput(candidate);
}

export function normalizeWhatsAppDirectIdentity(value: string): string | null {
  const normalized = normalizeWhatsAppTarget(value);
  if (!normalized || isWhatsAppGroupJid(normalized) || isWhatsAppNewsletterJid(normalized)) {
    return null;
  }
  return normalized;
}

export function normalizeWhatsAppMessagingTarget(raw: string): string | undefined {
  return normalizeWhatsAppTarget(raw) ?? undefined;
}

export function normalizeWhatsAppAllowFromEntries(allowFrom: Array<string | number>): string[] {
  return uniqueStrings(
    allowFrom
      .map(String)
      .map((entry) => normalizeWhatsAppAllowFromEntry(entry))
      .filter((entry): entry is string => Boolean(entry)),
  );
}

export function normalizeWhatsAppAllowFromEntry(entry: string): string | null {
  if (trimWhatsAppAsciiSpaces(entry) === "*") {
    return "*";
  }
  const normalized = normalizeWhatsAppTarget(entry);
  if (!normalized) {
    return null;
  }
  return normalized.startsWith("+") ? normalized.slice(1) : normalized;
}

export function looksLikeWhatsAppTargetId(raw: string): boolean {
  if (hasUnsafeWhatsAppTargetCharacters(raw)) {
    return false;
  }
  const asciiTrimmed = trimWhatsAppAsciiSpaces(raw);
  if (!asciiTrimmed) {
    return false;
  }
  return (
    /^whatsapp:/i.test(asciiTrimmed) ||
    isWhatsAppGroupJid(raw) ||
    isWhatsAppNewsletterJid(raw) ||
    isWhatsAppUserTarget(raw) ||
    normalizeWhatsAppTarget(raw) !== null
  );
}
