// Provider-contract guarded OpenAI-compatible Chat video projection.
import { createHash } from "node:crypto";
import {
  createNativeVideoAdmissionAccumulator,
  NATIVE_VIDEO_OMISSION,
  resolveNativeVideoInputContract,
  type NativeVideoAdmission,
  type NativeVideoInputContract,
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

type OpenAICompatibleChatVideoPriorityTier = "current-user" | "historical";
type OpenAICompatibleChatVideoProvenanceEntry = {
  contentIdentity: unknown[];
  contentIndex: number;
  dataLength: number;
  fingerprint: string;
  messageIndex: number;
  mimeType: string;
  occurrence: number;
  priorityTier: OpenAICompatibleChatVideoPriorityTier;
};
export type OpenAICompatibleChatVideoProvenance = {
  byIdentity: WeakMap<object, OpenAICompatibleChatVideoProvenanceEntry>;
  byLocation: Map<string, OpenAICompatibleChatVideoProvenanceEntry>;
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
  const mimeType = value.slice(5, markerIndex);
  if (
    markerIndex <= 5 ||
    value.includes(marker, markerIndex + marker.length) ||
    !/^video\//iu.test(mimeType)
  ) {
    return undefined;
  }
  return {
    mimeType,
    data: value.slice(markerIndex + marker.length),
  };
}

function serializedUtf8Bytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function openAICompatibleChatVideoFingerprint(candidate: {
  data: string;
  mimeType: string;
}): string {
  return createHash("sha256")
    .update(candidate.mimeType)
    .update("\0")
    .update(candidate.data)
    .digest("hex");
}

function openAICompatibleChatVideoLocationKey(messageIndex: number, contentIndex: number): string {
  return `${messageIndex}:${contentIndex}`;
}

const OPENAI_INLINE_VIDEO_MAX_NESTING = 4;
const OPENAI_INLINE_VIDEO_CARRIERS = [
  "source",
  "video_url",
  "image_url",
  "data",
  "blob",
  "url",
] as const;
const OPENAI_VIDEO_TYPES = new Set(["video", "input_video", "video_url"]);
const OPENAI_VIDEO_MIME_FIELDS = [
  "mimeType",
  "mime_type",
  "mediaType",
  "media_type",
  "contentType",
  "content_type",
] as const;

function isOpenAIInlineVideoDataUrl(value: unknown): boolean {
  return typeof value === "string" && /^data:video\//iu.test(value.trimStart());
}

function hasOpenAIVideoTypeOrMime(record: Record<string, unknown>): boolean {
  const type = typeof record.type === "string" ? record.type.trim().toLowerCase() : "";
  return (
    OPENAI_VIDEO_TYPES.has(type) ||
    OPENAI_VIDEO_MIME_FIELDS.some((field) => {
      const value = record[field];
      return typeof value === "string" && /^video\//iu.test(value.trim());
    })
  );
}

function containsOpenAIInlineVideoPayload(
  value: unknown,
  enclosingVideo = false,
  depth = 0,
  seen: WeakSet<object> = new WeakSet<object>(),
): boolean {
  if (!value || typeof value !== "object") {
    return isOpenAIInlineVideoDataUrl(value);
  }
  if (seen.has(value) || depth > OPENAI_INLINE_VIDEO_MAX_NESTING) {
    return false;
  }
  seen.add(value);
  const record = value as Record<string, unknown>;
  const videoContext = enclosingVideo || hasOpenAIVideoTypeOrMime(record);
  for (const key of OPENAI_INLINE_VIDEO_CARRIERS) {
    const carrier = record[key];
    if (isOpenAIInlineVideoDataUrl(carrier)) {
      seen.delete(value);
      return true;
    }
    if (videoContext && (key === "data" || key === "blob") && carrier !== undefined) {
      seen.delete(value);
      return true;
    }
    if (
      depth < OPENAI_INLINE_VIDEO_MAX_NESTING &&
      carrier &&
      typeof carrier === "object" &&
      containsOpenAIInlineVideoPayload(carrier, videoContext, depth + 1, seen)
    ) {
      seen.delete(value);
      return true;
    }
  }
  seen.delete(value);
  return false;
}

/** Captures transport-produced ordinary-user video without retaining another base64 copy. */
export function captureOpenAICompatibleChatVideoProvenance(
  params: Record<string, unknown>,
): OpenAICompatibleChatVideoProvenance {
  const byIdentity = new WeakMap<object, OpenAICompatibleChatVideoProvenanceEntry>();
  const byLocation = new Map<string, OpenAICompatibleChatVideoProvenanceEntry>();
  const entries: OpenAICompatibleChatVideoProvenanceEntry[] = [];
  const occurrences = new Map<string, number>();
  const messages = Array.isArray(params.messages) ? params.messages : [];
  let currentUserVideoMessageIndex = -1;
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
    const message = messages[messageIndex];
    if (!message || typeof message !== "object") {
      continue;
    }
    const record = message as { role?: unknown; content?: unknown };
    if (record.role !== "user" || !Array.isArray(record.content)) {
      continue;
    }
    for (let contentIndex = 0; contentIndex < record.content.length; contentIndex += 1) {
      const part = record.content[contentIndex];
      if (!part || typeof part !== "object" || (part as { type?: unknown }).type !== "video_url") {
        continue;
      }
      const parsed = parseVideoDataUrl((part as { video_url?: { url?: unknown } }).video_url?.url);
      if (!parsed) {
        continue;
      }
      const fingerprint = openAICompatibleChatVideoFingerprint(parsed);
      const occurrence = occurrences.get(fingerprint) ?? 0;
      const entry: OpenAICompatibleChatVideoProvenanceEntry = {
        contentIdentity: record.content,
        contentIndex,
        dataLength: parsed.data.length,
        fingerprint,
        messageIndex,
        mimeType: parsed.mimeType,
        occurrence,
        priorityTier: "historical",
      };
      entries.push(entry);
      occurrences.set(fingerprint, occurrence + 1);
      byIdentity.set(part, entry);
      byLocation.set(openAICompatibleChatVideoLocationKey(messageIndex, contentIndex), entry);
      currentUserVideoMessageIndex = messageIndex;
    }
  }
  for (const entry of entries) {
    if (entry.messageIndex === currentUserVideoMessageIndex) {
      entry.priorityTier = "current-user";
    }
  }
  return { byIdentity, byLocation };
}

function openAICompatibleChatVideoMatchesProvenance(
  candidate: { data: string; mimeType: string },
  entry: OpenAICompatibleChatVideoProvenanceEntry,
): boolean {
  return (
    candidate.mimeType === entry.mimeType &&
    candidate.data.length === entry.dataLength &&
    openAICompatibleChatVideoFingerprint(candidate) === entry.fingerprint
  );
}

function matchOpenAICompatibleChatVideoProvenance(params: {
  candidate: { data: string; mimeType: string };
  content: unknown[];
  contentIndex: number;
  messageIndex: number;
  part: object;
  provenance: OpenAICompatibleChatVideoProvenance;
  role: unknown;
  used: Set<OpenAICompatibleChatVideoProvenanceEntry>;
}): OpenAICompatibleChatVideoProvenanceEntry | undefined {
  if (params.role !== "user") {
    return undefined;
  }
  const identityEntry = params.provenance.byIdentity.get(params.part);
  if (
    identityEntry &&
    identityEntry.contentIdentity === params.content &&
    identityEntry.contentIndex === params.contentIndex &&
    !params.used.has(identityEntry) &&
    openAICompatibleChatVideoMatchesProvenance(params.candidate, identityEntry)
  ) {
    params.used.add(identityEntry);
    return identityEntry;
  }
  const replacementEntry = params.provenance.byLocation.get(
    openAICompatibleChatVideoLocationKey(params.messageIndex, params.contentIndex),
  );
  if (
    replacementEntry &&
    replacementEntry.messageIndex === params.messageIndex &&
    replacementEntry.contentIndex === params.contentIndex &&
    !params.used.has(replacementEntry) &&
    openAICompatibleChatVideoMatchesProvenance(params.candidate, replacementEntry)
  ) {
    params.used.add(replacementEntry);
    return replacementEntry;
  }
  return undefined;
}

/** Admit newest user-message videos first without changing their eventual wire order. */
export function planOpenAICompatibleChatVideoAdmission(
  messageCandidates: readonly (readonly (Pick<MediaContent, "data" | "mimeType"> | undefined)[])[],
  contract: NativeVideoInputContract | undefined,
): (NativeVideoAdmission | undefined)[][] {
  const admission = createNativeVideoAdmissionAccumulator({
    contract,
    wireFamily: "openai-chat-video-url",
  });
  const plan = messageCandidates.map((candidates) =>
    Array<NativeVideoAdmission | undefined>(candidates.length),
  );
  for (let messageIndex = messageCandidates.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const candidates = messageCandidates[messageIndex] ?? [];
    const results = plan[messageIndex];
    for (let contentIndex = 0; contentIndex < candidates.length; contentIndex += 1) {
      const candidate = candidates[contentIndex];
      if (candidate && results) {
        results[contentIndex] = admission.admit(candidate);
      }
    }
  }
  return plan;
}

/** Final request guard, including payload-hook mutations and serialized body overhead. */
export function enforceOpenAICompatibleChatVideoRequestLimits<T extends Record<string, unknown>>(
  params: T,
  model: Pick<Model, "nativeVideoInput">,
  provenance: OpenAICompatibleChatVideoProvenance,
): T {
  const contract = resolveNativeVideoInputContract(model);
  const omissionPart = { type: "text", text: NATIVE_VIDEO_OMISSION };
  const omissionBytes = serializedUtf8Bytes(omissionPart);
  const accepted: Array<{
    content: unknown[];
    entry: OpenAICompatibleChatVideoProvenanceEntry;
    index: number;
    serializedDelta: number;
  }> = [];
  const messages = Array.isArray(params.messages) ? params.messages : [];
  const usedProvenance = new Set<OpenAICompatibleChatVideoProvenanceEntry>();
  const candidates: Array<{
    content: unknown[];
    contentIndex: number;
    entry: OpenAICompatibleChatVideoProvenanceEntry;
    parsed: { data: string; mimeType: string };
  }> = [];
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
    const message = messages[messageIndex];
    if (!message || typeof message !== "object") {
      continue;
    }
    const record = message as { role?: unknown; content?: unknown };
    if (!Array.isArray(record.content)) {
      continue;
    }
    for (let contentIndex = 0; contentIndex < record.content.length; contentIndex += 1) {
      const part = record.content[contentIndex];
      if (!part || typeof part !== "object") {
        continue;
      }
      const parsed =
        (part as { type?: unknown }).type === "video_url"
          ? parseVideoDataUrl((part as { video_url?: { url?: unknown } }).video_url?.url)
          : undefined;
      if (!parsed) {
        if (containsOpenAIInlineVideoPayload(part)) {
          record.content[contentIndex] = omissionPart;
        }
        continue;
      }
      const entry = parsed
        ? matchOpenAICompatibleChatVideoProvenance({
            candidate: parsed,
            content: record.content,
            contentIndex,
            messageIndex,
            part,
            provenance,
            role: record.role,
            used: usedProvenance,
          })
        : undefined;
      if (!entry) {
        record.content[contentIndex] = omissionPart;
        continue;
      }
      candidates.push({
        content: record.content,
        contentIndex,
        entry,
        parsed,
      });
    }
  }
  const provenanceCandidates: Array<Array<Pick<MediaContent, "data" | "mimeType"> | undefined>> =
    [];
  for (const candidate of candidates) {
    const row = provenanceCandidates[candidate.entry.messageIndex] ?? [];
    row[candidate.entry.contentIndex] = candidate.parsed;
    provenanceCandidates[candidate.entry.messageIndex] = row;
  }
  const plan = planOpenAICompatibleChatVideoAdmission(provenanceCandidates, contract);
  for (const candidate of candidates) {
    const result = plan[candidate.entry.messageIndex]?.[candidate.entry.contentIndex];
    if (!result?.ok) {
      candidate.content[candidate.contentIndex] = omissionPart;
      continue;
    }
    const part: OpenAICompatibleChatVideoContentPart = {
      type: "video_url",
      video_url: {
        url: `data:${result.wireMimeType};base64,${candidate.parsed.data}`,
      },
    };
    candidate.content[candidate.contentIndex] = part;
    accepted.push({
      content: candidate.content,
      entry: candidate.entry,
      index: candidate.contentIndex,
      serializedDelta: Math.max(0, serializedUtf8Bytes(part) - omissionBytes),
    });
  }
  if (contract) {
    accepted.sort(
      (left, right) =>
        Number(left.entry.priorityTier === "current-user") -
          Number(right.entry.priorityTier === "current-user") ||
        left.entry.messageIndex - right.entry.messageIndex ||
        left.entry.contentIndex - right.entry.contentIndex,
    );
    let requestBytes = serializedUtf8Bytes(params);
    // Provenance order, not hook order, preserves current input and evicts oldest history first.
    while (accepted.length > 0 && requestBytes >= contract.maxSerializedRequestBytesExclusive) {
      const rejected = accepted.shift();
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
