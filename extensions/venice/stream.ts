// Venice plugin module implements stream behavior.
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  createPayloadPatchStreamWrapper,
  normalizeOpenAICompatibleReasoningReplay,
} from "openclaw/plugin-sdk/provider-stream-shared";

function isVeniceDeepSeekV4ModelId(modelId: unknown): boolean {
  return modelId === "deepseek-v4-flash" || modelId === "deepseek-v4-pro";
}

function isVeniceGeminiModelId(modelId: unknown): boolean {
  return typeof modelId === "string" && modelId.trim().toLowerCase().startsWith("gemini-");
}

function isVeniceGemini3ModelId(modelId: unknown): boolean {
  return typeof modelId === "string" && /^gemini-3(?:[.-]|$)/.test(modelId.trim().toLowerCase());
}

const GEMINI_THOUGHT_SIGNATURE_VALIDATOR_SKIP = "skip_thought_signature_validator";

function applyVeniceGeminiThoughtSignatures(
  payload: Record<string, unknown>,
  context: Parameters<NonNullable<ProviderWrapStreamFnContext["streamFn"]>>[1],
  model: Parameters<NonNullable<ProviderWrapStreamFnContext["streamFn"]>>[0],
): void {
  if (model.provider !== "venice" || !isVeniceGeminiModelId(model.id)) {
    return;
  }
  const signaturesByToolCallId = new Map<string, string>();
  const fallbackSignature = isVeniceGemini3ModelId(model.id)
    ? GEMINI_THOUGHT_SIGNATURE_VALIDATOR_SKIP
    : undefined;
  for (const message of context.messages ?? []) {
    if (message.role !== "assistant") {
      continue;
    }
    if (
      message.api !== model.api ||
      message.provider !== model.provider ||
      message.model !== model.id
    ) {
      continue;
    }
    for (const block of message.content) {
      if (
        block.type === "toolCall" &&
        typeof block.id === "string" &&
        typeof block.thoughtSignature === "string" &&
        block.thoughtSignature.length > 0
      ) {
        signaturesByToolCallId.set(block.id, block.thoughtSignature);
      }
    }
  }
  if (
    (signaturesByToolCallId.size === 0 && !fallbackSignature) ||
    !Array.isArray(payload.messages)
  ) {
    return;
  }
  for (const message of payload.messages) {
    if (!message || typeof message !== "object") {
      continue;
    }
    const record = message as Record<string, unknown>;
    if (record.role !== "assistant" || !Array.isArray(record.tool_calls)) {
      continue;
    }
    for (const toolCall of record.tool_calls) {
      if (!toolCall || typeof toolCall !== "object") {
        continue;
      }
      const toolCallRecord = toolCall as Record<string, unknown>;
      const signature =
        typeof toolCallRecord.id === "string"
          ? signaturesByToolCallId.get(toolCallRecord.id)
          : undefined;
      if (signature) {
        toolCallRecord.thought_signature = signature;
      } else if (
        fallbackSignature &&
        (typeof toolCallRecord.thought_signature !== "string" ||
          toolCallRecord.thought_signature.length === 0)
      ) {
        // Gemini 3 validates every historical function call, including calls
        // imported from another provider or recorded before signature capture.
        toolCallRecord.thought_signature = fallbackSignature;
      }
    }
  }
}

export function createVeniceStreamWrapper(
  baseStreamFn: ProviderWrapStreamFnContext["streamFn"],
  thinkingLevel: ProviderWrapStreamFnContext["thinkingLevel"],
): ProviderWrapStreamFnContext["streamFn"] {
  void thinkingLevel;
  return createPayloadPatchStreamWrapper(baseStreamFn, ({ payload, context, model }) => {
    if (model.provider === "venice" && isVeniceDeepSeekV4ModelId(model.id)) {
      delete payload.thinking;
      delete payload.reasoning;
      delete payload.reasoning_effort;
      normalizeOpenAICompatibleReasoningReplay(payload, {
        thinkingEnabled: true,
        replaceNullReasoningContent: true,
      });
    }
    applyVeniceGeminiThoughtSignatures(payload, context, model);
  });
}
