// Whatsapp plugin module implements resolve outbound target behavior.
import { missingTargetError } from "openclaw/plugin-sdk/channel-feedback";
import {
  isWhatsAppGroupJid,
  isWhatsAppNewsletterJid,
  normalizeWhatsAppTarget,
} from "./normalize-target.js";
import { trimWhatsAppAsciiSpaces } from "./phone-input.js";

type WhatsAppOutboundTargetResolution = { ok: true; to: string } | { ok: false; error: Error };

function whatsappAllowFromPolicyError(target: string): Error {
  return new Error(`Target "${target}" is not listed in the configured WhatsApp allowFrom policy.`);
}

export function resolveWhatsAppOutboundTarget(params: {
  to: string | null | undefined;
  allowFrom: Array<string | number> | null | undefined;
  mode: string | null | undefined;
}): WhatsAppOutboundTargetResolution {
  const rawTo = params.to ?? "";
  if (!rawTo) {
    return {
      ok: false,
      error: missingTargetError("WhatsApp", "<E.164|group JID|newsletter JID>"),
    };
  }

  const normalizedTo = normalizeWhatsAppTarget(rawTo);
  if (!normalizedTo) {
    return {
      ok: false,
      error: missingTargetError("WhatsApp", "<E.164|group JID|newsletter JID>"),
    };
  }
  if (isWhatsAppGroupJid(normalizedTo) || isWhatsAppNewsletterJid(normalizedTo)) {
    return { ok: true, to: normalizedTo };
  }

  const allowListRaw = (params.allowFrom ?? []).map(String);
  const hasWildcard = allowListRaw.some((entry) => trimWhatsAppAsciiSpaces(entry) === "*");
  const allowList = allowListRaw
    .filter((entry) => trimWhatsAppAsciiSpaces(entry) !== "*")
    .map((entry) => normalizeWhatsAppTarget(entry))
    .filter((entry): entry is string => Boolean(entry));
  if (hasWildcard || allowListRaw.length === 0) {
    return { ok: true, to: normalizedTo };
  }
  if (allowList.includes(normalizedTo)) {
    return { ok: true, to: normalizedTo };
  }
  return {
    ok: false,
    error: whatsappAllowFromPolicyError(normalizedTo),
  };
}
