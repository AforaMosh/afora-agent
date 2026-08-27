// Identifies Afora-authored assistant rows that are transcript bookkeeping,
// not provider model output. Some history surfaces keep gateway-injected rows
// visible, so use the narrower delivery-mirror predicate when visibility matters.
export const AFORA_TRANSCRIPT_ARTIFACT_API = "afora-transcript" as const;
export const AFORA_TRANSCRIPT_ARTIFACT_PROVIDER = "afora" as const;
export const AFORA_DELIVERY_MIRROR_MODEL = "delivery-mirror" as const;
const AFORA_GATEWAY_INJECTED_MODEL = "gateway-injected" as const;

const TRANSCRIPT_ONLY_AFORA_ASSISTANT_MODELS = new Set<string>([
  AFORA_DELIVERY_MIRROR_MODEL,
  AFORA_GATEWAY_INJECTED_MODEL,
]);
const AFORA_DELIVERY_MIRROR_KINDS = new Set([
  "channel-final",
  "channel-final-suppressed",
  "message-tool-source-reply",
]);

function isAforaDeliveryMirrorMarker(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const kind = (value as { kind?: unknown }).kind;
  return typeof kind === "string" && AFORA_DELIVERY_MIRROR_KINDS.has(kind);
}

export function isTranscriptOnlyAforaAssistantModel(provider: unknown, model: unknown): boolean {
  return (
    provider === AFORA_TRANSCRIPT_ARTIFACT_PROVIDER &&
    typeof model === "string" &&
    TRANSCRIPT_ONLY_AFORA_ASSISTANT_MODELS.has(model)
  );
}

/**
 * Returns true when the message is an Afora-authored transcript artifact
 * that must not be replayed to providers.
 *
 * Primary check: provider="afora" + model in known transcript-only set.
 * Fallback: a valid aforaDeliveryMirror marker catches observed historical
 * rows whose provider/model provenance was stripped (#99470).
 */
export function isTranscriptOnlyAforaAssistantMessage(message: unknown): boolean {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return false;
  }
  const entry = message as {
    role?: unknown;
    provider?: unknown;
    model?: unknown;
    aforaDeliveryMirror?: unknown;
  };
  if (entry.role !== "assistant") {
    return false;
  }
  if (isTranscriptOnlyAforaAssistantModel(entry.provider, entry.model)) {
    return true;
  }
  return isAforaDeliveryMirrorMarker(entry.aforaDeliveryMirror);
}

export function isAforaMessageToolMirrorAssistantMessage(message: unknown): boolean {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return false;
  }
  const entry = message as { role?: unknown; aforaMessageToolMirror?: unknown };
  return entry.role === "assistant" && entry.aforaMessageToolMirror !== undefined;
}

export function isAforaInternalSourceReplyMirrorAssistantMessage(message: unknown): boolean {
  if (!isAforaMessageToolMirrorAssistantMessage(message)) {
    return false;
  }
  const marker = (message as { aforaMessageToolMirror?: unknown }).aforaMessageToolMirror;
  return (
    Boolean(marker) &&
    typeof marker === "object" &&
    !Array.isArray(marker) &&
    (marker as { sourceReplySink?: unknown }).sourceReplySink === "internal-ui"
  );
}

export function isAforaDeliveryMirrorAssistantMessage(message: unknown): boolean {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return false;
  }
  const entry = message as { role?: unknown; provider?: unknown; model?: unknown };
  return (
    entry.role === "assistant" &&
    entry.provider === AFORA_TRANSCRIPT_ARTIFACT_PROVIDER &&
    entry.model === AFORA_DELIVERY_MIRROR_MODEL
  );
}
