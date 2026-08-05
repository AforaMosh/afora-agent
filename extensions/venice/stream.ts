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

function stringifyHistoricalValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === null || value === undefined) {
    return "";
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function describeHistoricalToolCall(toolCall: Record<string, unknown>): {
  id?: string;
  name: string;
  text: string;
} {
  const fn =
    toolCall.function && typeof toolCall.function === "object"
      ? (toolCall.function as Record<string, unknown>)
      : {};
  const name = typeof fn.name === "string" && fn.name.length > 0 ? fn.name : "unknown_tool";
  const args = stringifyHistoricalValue(fn.arguments) || "{}";
  return {
    ...(typeof toolCall.id === "string" ? { id: toolCall.id } : {}),
    name,
    text: `[Historical tool call: ${name}(${args})]`,
  };
}

function applyVeniceGeminiToolHistoryCompatibility(
  payload: Record<string, unknown>,
  context: Parameters<NonNullable<ProviderWrapStreamFnContext["streamFn"]>>[1],
  model: Parameters<NonNullable<ProviderWrapStreamFnContext["streamFn"]>>[0],
): void {
  if (model.provider !== "venice" || !isVeniceGeminiModelId(model.id)) {
    return;
  }
  const signaturesByToolCallId = new Map<string, string>();
  const requiresUnsignedCallFallback = isVeniceGemini3ModelId(model.id);
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
    (signaturesByToolCallId.size === 0 && !requiresUnsignedCallFallback) ||
    !Array.isArray(payload.messages)
  ) {
    return;
  }
  const downgradedToolCalls = new Map<string, string>();
  for (const message of payload.messages) {
    if (!message || typeof message !== "object") {
      continue;
    }
    const record = message as Record<string, unknown>;
    if (record.role !== "assistant" || !Array.isArray(record.tool_calls)) {
      continue;
    }
    let shouldDowngradeBatch = false;
    const describedCalls: Array<ReturnType<typeof describeHistoricalToolCall>> = [];
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
      } else if (requiresUnsignedCallFallback) {
        shouldDowngradeBatch = true;
      }
      describedCalls.push(describeHistoricalToolCall(toolCallRecord));
    }
    if (!shouldDowngradeBatch) {
      continue;
    }
    for (const call of describedCalls) {
      if (call.id) {
        downgradedToolCalls.set(call.id, call.name);
      }
    }
    const existingContent = stringifyHistoricalValue(record.content);
    record.content = [existingContent, ...describedCalls.map((call) => call.text)]
      .filter((part) => part.length > 0)
      .join("\n");
    delete record.tool_calls;
  }
  if (downgradedToolCalls.size === 0) {
    return;
  }
  for (const message of payload.messages) {
    if (!message || typeof message !== "object") {
      continue;
    }
    const record = message as Record<string, unknown>;
    const toolCallId = typeof record.tool_call_id === "string" ? record.tool_call_id : undefined;
    const toolName = toolCallId ? downgradedToolCalls.get(toolCallId) : undefined;
    if (record.role !== "tool" || !toolName) {
      continue;
    }
    const result = stringifyHistoricalValue(record.content);
    for (const key of Object.keys(record)) {
      delete record[key];
    }
    record.role = "user";
    record.content = `[Historical tool result for ${toolName}:\n${result}]`;
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
    applyVeniceGeminiToolHistoryCompatibility(payload, context, model);
  });
}
