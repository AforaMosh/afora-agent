// Provider-contract guarded OpenAI-compatible Chat video projection.
import {
  createNativeVideoAdmissionAccumulator,
  NATIVE_VIDEO_OMISSION,
  resolveNativeVideoInputContract,
} from "@openclaw/llm-core";
import type {
  ChatCompletionContentPart,
  ChatCompletionContentPartImage,
} from "openai/resources/chat/completions.js";
import type { MediaContent, Model } from "../types.js";

type OpenAICompatibleChatVideoContentPart = {
  type: "video_url";
  video_url: { url: string };
};

export type OpenAICompatibleChatContentPart =
  | ChatCompletionContentPart
  | OpenAICompatibleChatVideoContentPart;

export function buildOpenAICompatibleChatMediaPart(
  media: MediaContent,
  wireMimeType = media.mimeType,
): ChatCompletionContentPartImage | OpenAICompatibleChatVideoContentPart {
  const url = `data:${wireMimeType};base64,${media.data}`;
  return media.type === "video"
    ? { type: "video_url", video_url: { url } }
    : { type: "image_url", image_url: { url } };
}

function parseVideoDataUrl(value: unknown): { mimeType: string; data: string } | undefined {
  if (typeof value !== "string" || !value.startsWith("data:")) {
    return undefined;
  }
  const marker = ";base64,";
  const markerIndex = value.indexOf(marker, 5);
  if (markerIndex <= 5 || value.indexOf(marker, markerIndex + marker.length) !== -1) {
    return undefined;
  }
  return {
    mimeType: value.slice(5, markerIndex),
    data: value.slice(markerIndex + marker.length),
  };
}

function serializedUtf8Bytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

/** Final request guard, including payload-hook mutations and serialized body overhead. */
export function enforceOpenAICompatibleChatVideoRequestLimits<T extends Record<string, unknown>>(
  params: T,
  model: Pick<Model, "nativeVideoInput">,
): T {
  const contract = resolveNativeVideoInputContract(model);
  const admission = createNativeVideoAdmissionAccumulator({
    contract,
    wireFamily: "openai-chat-video-url",
  });
  const omissionPart = { type: "text", text: NATIVE_VIDEO_OMISSION };
  const omissionBytes = serializedUtf8Bytes(omissionPart);
  const accepted: Array<{ content: unknown[]; index: number; serializedDelta: number }> = [];
  const messages = Array.isArray(params.messages) ? params.messages : [];
  for (const message of messages) {
    if (!message || typeof message !== "object") {
      continue;
    }
    const record = message as { role?: unknown; content?: unknown };
    if (!Array.isArray(record.content)) {
      continue;
    }
    for (let index = 0; index < record.content.length; index += 1) {
      const part = record.content[index];
      if (!part || typeof part !== "object" || (part as { type?: unknown }).type !== "video_url") {
        continue;
      }
      const parsed = parseVideoDataUrl((part as { video_url?: { url?: unknown } }).video_url?.url);
      const result = record.role === "user" && parsed ? admission.admit(parsed) : undefined;
      if (!result?.ok) {
        record.content[index] = omissionPart;
        continue;
      }
      (part as OpenAICompatibleChatVideoContentPart).video_url.url =
        `data:${result.wireMimeType};base64,${parsed.data}`;
      accepted.push({
        content: record.content,
        index,
        serializedDelta: Math.max(0, serializedUtf8Bytes(part) - omissionBytes),
      });
    }
  }
  if (contract) {
    let requestBytes = serializedUtf8Bytes(params);
    while (accepted.length > 0 && requestBytes >= contract.maxSerializedRequestBytesExclusive) {
      const rejected = accepted.pop();
      if (rejected) {
        rejected.content[rejected.index] = omissionPart;
        requestBytes -= rejected.serializedDelta;
      }
    }
    // Custom hook values can define unusual serialization behavior. Verify once,
    // then fail closed without serializing the whole request after every removal.
    if (
      accepted.length > 0 &&
      serializedUtf8Bytes(params) >= contract.maxSerializedRequestBytesExclusive
    ) {
      for (const rejected of accepted) {
        rejected.content[rejected.index] = omissionPart;
      }
    }
  }
  return params;
}
