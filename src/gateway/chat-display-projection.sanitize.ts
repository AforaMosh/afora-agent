import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { asOptionalRecord as readRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeCanonicalInboundMediaUri } from "../media/media-reference-projection.js";
import {
  parseAssistantTextSignature,
  resolveAssistantMessagePhase,
} from "../shared/chat-message-content.js";
import { stripInlineDirectiveTagsForDisplay } from "../utils/directive-tags.js";
import {
  isToolHistoryBlockType,
  isToolResultHistoryBlockType,
  messageHasToolResultShape,
  projectToolResultDetails,
} from "./chat-display-projection.canvas.js";
import {
  DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS,
  extractAssistantTextForSilentCheck,
  hasAssistantDisplayableNonTextContent,
  isAssistantTextContentType,
  isProjectedSessionsSendForwardedMessage,
  shouldPreserveAssistantControlReplyText,
  truncateChatHistoryText,
} from "./chat-display-projection.helpers.js";
import {
  projectChatHistoryMediaReference,
  sanitizeChatHistoryMediaContentBlock,
} from "./chat-display-projection.media.js";
import {
  isSuppressedControlReplyText,
  stripSuppressedControlReplyToken,
} from "./control-reply-text.js";
import {
  projectWorkspaceResultConflict,
  WORKSPACE_CONFLICT_TRANSCRIPT_TYPE,
} from "./worker-environments/workspace-conflicts.js";

function projectChatHistoryMediaFacts(value: unknown): unknown[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.flatMap((fact) => {
    const source = readRecord(fact);
    if (!source) {
      return [];
    }
    const projected = { ...source };
    const managedUri =
      normalizeCanonicalInboundMediaUri(source.url) ??
      normalizeCanonicalInboundMediaUri(source.path);
    if (managedUri) {
      projected.url = managedUri;
      delete projected.path;
    }
    for (const key of ["path", "url"] as const) {
      const normalized = projectChatHistoryMediaReference(projected[key]);
      if (normalized) {
        projected[key] = normalized;
      } else {
        delete projected[key];
      }
    }
    delete projected.workspaceDir;
    return [projected];
  });
}

function projectLegacyChatHistoryMediaCarriers(entry: Record<string, unknown>): boolean {
  let changed = false;
  if ("media" in entry) {
    const media = projectChatHistoryMediaFacts(entry.media);
    if (media) {
      entry.media = media;
    } else {
      delete entry.media;
    }
    changed = true;
  }
  for (const key of ["MediaPath", "MediaUrl"] as const) {
    const value = entry[key];
    if (typeof value !== "string") {
      continue;
    }
    const normalized = projectChatHistoryMediaReference(value);
    if (normalized) {
      entry[key] = normalized;
    } else {
      delete entry[key];
    }
    changed ||= normalized !== value;
  }
  for (const key of ["MediaPaths", "MediaUrls"] as const) {
    const value = entry[key];
    if (!Array.isArray(value)) {
      continue;
    }
    const persistedMedia = readRecord(entry["__openclaw"])?.media;
    // Legacy arrays share indexes with type and canonical facts. Retain a blank
    // rejected slot only while another carrier still owns that position.
    const hasParallelPositions =
      value.some((reference) => typeof reference !== "string" || !reference.trim()) ||
      typeof entry.MediaPath === "string" ||
      typeof entry.MediaUrl === "string" ||
      typeof entry.MediaType === "string" ||
      (Array.isArray(entry.MediaTranscribedIndexes) && entry.MediaTranscribedIndexes.length > 0) ||
      (Array.isArray(persistedMedia) && persistedMedia.length > 0) ||
      ["media", "MediaPaths", "MediaUrls", "MediaTypes"].some((carrier) => {
        const parallel = entry[carrier];
        return carrier !== key && Array.isArray(parallel) && parallel.length > 0;
      });
    const projected = value.flatMap((reference) => {
      if (typeof reference !== "string") {
        return [reference];
      }
      const normalized = projectChatHistoryMediaReference(reference);
      return normalized ? [normalized] : hasParallelPositions ? [""] : [];
    });
    if (
      projected.length !== value.length ||
      projected.some((reference, index) => reference !== value[index])
    ) {
      if (projected.length > 0) {
        entry[key] = projected;
      } else {
        delete entry[key];
      }
      changed = true;
    }
  }
  return changed;
}

export function sanitizeChatHistoryContentBlock(
  block: unknown,
  opts?: {
    preserveExactToolPayload?: boolean;
    preserveInlineImageData?: boolean;
    maxChars?: number;
  },
): { block: unknown; changed: boolean } {
  if (!block || typeof block !== "object") {
    return { block, changed: false };
  }
  const entry = { ...(block as Record<string, unknown>) };
  let changed = false;
  const preserveExactToolPayload =
    opts?.preserveExactToolPayload === true || isToolHistoryBlockType(entry.type);
  const maxChars = opts?.maxChars ?? DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS;
  if (isToolResultHistoryBlockType(entry.type) && "details" in entry) {
    const projectedDetails = projectToolResultDetails(entry.details, maxChars);
    if (projectedDetails) {
      entry.details = projectedDetails;
    } else {
      delete entry.details;
    }
    changed = true;
  }
  if (typeof entry.text === "string") {
    const stripped = stripInlineDirectiveTagsForDisplay(entry.text);
    if (preserveExactToolPayload) {
      entry.text = stripped.text;
      changed ||= stripped.changed;
    } else {
      const res = truncateChatHistoryText(stripped.text, maxChars);
      entry.text = res.text;
      changed ||= stripped.changed || res.truncated;
    }
  }
  if (typeof entry.content === "string") {
    const stripped = stripInlineDirectiveTagsForDisplay(entry.content);
    if (preserveExactToolPayload) {
      entry.content = stripped.text;
      changed ||= stripped.changed;
    } else {
      const res = truncateChatHistoryText(stripped.text, maxChars);
      entry.content = res.text;
      changed ||= stripped.changed || res.truncated;
    }
  }
  if (typeof entry.partialJson === "string" && !preserveExactToolPayload) {
    const res = truncateChatHistoryText(entry.partialJson, maxChars);
    entry.partialJson = res.text;
    changed ||= res.truncated;
  }
  if (typeof entry.arguments === "string" && !preserveExactToolPayload) {
    const res = truncateChatHistoryText(entry.arguments, maxChars);
    entry.arguments = res.text;
    changed ||= res.truncated;
  }
  if (typeof entry.thinking === "string") {
    const res = truncateChatHistoryText(entry.thinking, maxChars);
    entry.thinking = res.text;
    changed ||= res.truncated;
  }
  if ("thinkingSignature" in entry) {
    delete entry.thinkingSignature;
    changed = true;
  }
  if ("openclawReasoningReplay" in entry) {
    delete entry.openclawReasoningReplay;
    changed = true;
  }
  const sanitizedMedia = sanitizeChatHistoryMediaContentBlock(entry, {
    preserveInlineImageData: opts?.preserveInlineImageData,
  });
  if (sanitizedMedia) {
    const mediaChanged = changed || sanitizedMedia.changed;
    return { block: mediaChanged ? sanitizedMedia.block : block, changed: mediaChanged };
  }
  return { block: changed ? entry : block, changed };
}

function sanitizeAssistantPhasedContentBlocks(content: unknown[]): {
  content: unknown[];
  changed: boolean;
} {
  const hasExplicitPhasedText = content.some((block) => {
    if (!block || typeof block !== "object") {
      return false;
    }
    const entry = block as { type?: unknown; textSignature?: unknown };
    return entry.type === "text" && Boolean(parseAssistantTextSignature(entry)?.phase);
  });
  if (!hasExplicitPhasedText) {
    return { content, changed: false };
  }
  const filtered = content.filter((block) => {
    if (!block || typeof block !== "object") {
      return true;
    }
    const entry = block as { type?: unknown; textSignature?: unknown };
    if (entry.type !== "text") {
      return true;
    }
    return parseAssistantTextSignature(entry)?.phase === "final_answer";
  });
  return {
    content: filtered,
    changed: filtered.length !== content.length,
  };
}

function projectAssistantMixedToolContent(
  content: unknown[],
  maxChars: number,
): { content: unknown[]; changed: boolean } | null {
  const hasToolHistoryBlock = content.some((block) => {
    if (!block || typeof block !== "object") {
      return false;
    }
    return isToolHistoryBlockType((block as { type?: unknown }).type);
  });
  if (!hasToolHistoryBlock) {
    return null;
  }

  let hasVisibleText = false;
  const projectedContent: unknown[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const entry = block as { type?: unknown; text?: unknown };
    if (!isAssistantTextContentType(entry.type)) {
      projectedContent.push(block);
      continue;
    }
    if (typeof entry.text !== "string" || !entry.text.trim()) {
      continue;
    }
    const stripped = stripInlineDirectiveTagsForDisplay(entry.text);
    const truncated = truncateChatHistoryText(stripped.text, maxChars);
    if (truncated.text.trim()) {
      projectedContent.push({ type: "text", text: truncated.text });
      hasVisibleText = true;
    }
  }

  // Mixed messages supply both the visible bubble and its reasoning/tool trace.
  // Keep structured siblings or a history reload loses activity shown while live.
  return hasVisibleText ? { content: projectedContent, changed: true } : null;
}

function toFiniteNumber(x: unknown): number | undefined {
  return asFiniteNumber(x);
}

function sanitizeCost(raw: unknown): Record<string, number> | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const c = raw as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) {
    const value = toFiniteNumber(c[key]);
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function sanitizeUsage(raw: unknown): Record<string, number> | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const u = raw as Record<string, unknown>;
  const out: Record<string, number> = {};
  const knownFields = [
    "input",
    "output",
    "total",
    "totalTokens",
    "inputTokens",
    "outputTokens",
    "promptTokens",
    "completionTokens",
    "cacheRead",
    "cacheWrite",
    "cache_read_input_tokens",
    "cache_creation_input_tokens",
    "input_tokens",
    "output_tokens",
    "prompt_tokens",
    "completion_tokens",
    "total_tokens",
  ];

  for (const k of knownFields) {
    const n = toFiniteNumber(u[k]);
    if (n !== undefined) {
      out[k] = n;
    }
  }

  if ("cost" in u && u.cost != null && typeof u.cost === "object") {
    const sanitizedCost = sanitizeCost(u.cost);
    if (sanitizedCost) {
      (out as Record<string, unknown>).cost = sanitizedCost;
    }
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

function projectWorkspaceConflictDetails(
  entry: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (entry.role !== "custom" || entry.customType !== WORKSPACE_CONFLICT_TRANSCRIPT_TYPE) {
    return undefined;
  }
  const details = readRecord(entry.details);
  if (
    !details ||
    !Array.isArray(details.paths) ||
    details.paths.length === 0 ||
    !details.paths.every(
      (entryPath): entryPath is string => typeof entryPath === "string" && entryPath.length > 0,
    ) ||
    typeof details.stagedResultRef !== "string" ||
    !/^refs\/openclaw\/worker-results\/[A-Za-z0-9-]+$/u.test(details.stagedResultRef) ||
    (details.totalCount !== undefined &&
      (!Number.isSafeInteger(details.totalCount) ||
        (details.totalCount as number) < details.paths.length))
  ) {
    return undefined;
  }
  try {
    return projectWorkspaceResultConflict(
      details.paths,
      details.stagedResultRef,
      details.totalCount as number | undefined,
    );
  } catch {
    return undefined;
  }
}

export function sanitizeChatHistoryMessage(
  message: unknown,
  maxChars: number = DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS,
  opts?: { preserveInlineImageData?: boolean },
): { message: unknown; changed: boolean } {
  if (!message || typeof message !== "object") {
    return { message, changed: false };
  }
  const entry = { ...(message as Record<string, unknown>) };
  let changed = projectLegacyChatHistoryMediaCarriers(entry);
  if ("providerReplay" in entry) {
    delete entry.providerReplay;
    changed = true;
  }
  const openClawMeta = readRecord(entry["__openclaw"]);
  if (openClawMeta && ("upstreamUserText" in openClawMeta || "media" in openClawMeta)) {
    // Codex retains the decorated upstream prompt for transcript reconstruction.
    // It is not display data and can otherwise evict the visible row from history.
    const projectedMeta = { ...openClawMeta };
    if ("upstreamUserText" in projectedMeta) {
      delete projectedMeta.upstreamUserText;
    }
    if ("media" in projectedMeta) {
      const projectedMedia = projectChatHistoryMediaFacts(projectedMeta.media);
      if (projectedMedia) {
        projectedMeta.media = projectedMedia;
      } else {
        delete projectedMeta.media;
      }
    }
    if (Object.keys(projectedMeta).length > 0) {
      entry["__openclaw"] = projectedMeta;
    } else {
      delete entry["__openclaw"];
    }
    changed = true;
  }
  const role = typeof entry.role === "string" ? entry.role.toLowerCase() : "";
  const preserveExactToolPayload =
    role === "toolresult" ||
    role === "tool_result" ||
    role === "tool" ||
    role === "function" ||
    typeof entry.toolName === "string" ||
    typeof entry.tool_name === "string" ||
    typeof entry.toolCallId === "string" ||
    typeof entry.tool_call_id === "string";

  if ("details" in entry) {
    const projectedDetails =
      projectWorkspaceConflictDetails(entry) ??
      (messageHasToolResultShape(entry)
        ? projectToolResultDetails(entry.details, maxChars)
        : undefined);
    if (projectedDetails) {
      entry.details = projectedDetails;
    } else {
      delete entry.details;
    }
    changed = true;
  }

  if (entry.role !== "assistant") {
    if ("usage" in entry) {
      delete entry.usage;
      changed = true;
    }
    if ("cost" in entry) {
      delete entry.cost;
      changed = true;
    }
  } else {
    if ("usage" in entry) {
      const sanitized = sanitizeUsage(entry.usage);
      if (sanitized) {
        entry.usage = sanitized;
      } else {
        delete entry.usage;
      }
      changed = true;
    }
    if ("cost" in entry) {
      const sanitized = sanitizeCost(entry.cost);
      if (sanitized) {
        entry.cost = sanitized;
      } else {
        delete entry.cost;
      }
      changed = true;
    }
  }

  const stripAssistantControlTokens =
    role === "assistant" && !shouldPreserveAssistantControlReplyText(entry);

  if (typeof entry.content === "string") {
    const stripped = stripInlineDirectiveTagsForDisplay(entry.content);
    const controlStripped = stripAssistantControlTokens
      ? stripSuppressedControlReplyToken(stripped.text)
      : stripped.text;
    changed ||= controlStripped !== stripped.text;
    if (preserveExactToolPayload) {
      entry.content = controlStripped;
      changed ||= stripped.changed;
    } else {
      const res = truncateChatHistoryText(controlStripped, maxChars);
      entry.content = res.text;
      changed ||= stripped.changed || res.truncated;
    }
  } else if (Array.isArray(entry.content)) {
    const updated = entry.content.map((block) => {
      const sanitized = sanitizeChatHistoryContentBlock(block, {
        preserveExactToolPayload,
        preserveInlineImageData:
          entry.role === "assistant" && opts?.preserveInlineImageData === true,
        maxChars,
      });
      if (
        !stripAssistantControlTokens ||
        !sanitized.block ||
        typeof sanitized.block !== "object" ||
        Array.isArray(sanitized.block)
      ) {
        return sanitized;
      }
      const contentBlock = sanitized.block as { type?: unknown; text?: unknown };
      if (!isAssistantTextContentType(contentBlock.type) || typeof contentBlock.text !== "string") {
        return sanitized;
      }
      const text = stripSuppressedControlReplyToken(contentBlock.text);
      return text === contentBlock.text
        ? sanitized
        : { block: { ...contentBlock, text }, changed: true };
    });
    if (updated.some((item) => item.changed)) {
      entry.content = updated.map((item) => item.block);
      changed = true;
    }
    if (entry.role === "assistant" && Array.isArray(entry.content)) {
      const mixedToolContent = projectAssistantMixedToolContent(entry.content, maxChars);
      if (mixedToolContent) {
        entry.content = mixedToolContent.content;
        if (entry.phase === "commentary") {
          delete entry.phase;
        }
        changed = true;
      } else {
        const sanitizedPhases = sanitizeAssistantPhasedContentBlocks(entry.content);
        if (sanitizedPhases.changed) {
          entry.content = sanitizedPhases.content;
          changed = true;
        }
      }
    }
  }

  if (typeof entry.text === "string") {
    const stripped = stripInlineDirectiveTagsForDisplay(entry.text);
    const controlStripped = stripAssistantControlTokens
      ? stripSuppressedControlReplyToken(stripped.text)
      : stripped.text;
    changed ||= controlStripped !== stripped.text;
    if (preserveExactToolPayload) {
      entry.text = controlStripped;
      changed ||= stripped.changed;
    } else {
      const res = truncateChatHistoryText(controlStripped, maxChars);
      entry.text = res.text;
      changed ||= stripped.changed || res.truncated;
    }
  }

  return { message: changed ? entry : message, changed };
}

function hasAssistantMixedToolVisibleText(message: unknown): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return false;
  }
  let hasToolHistoryBlock = false;
  let hasText = false;
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const entry = block as { type?: unknown; text?: unknown };
    if (isToolHistoryBlockType(entry.type)) {
      hasToolHistoryBlock = true;
    }
    if (
      isAssistantTextContentType(entry.type) &&
      typeof entry.text === "string" &&
      entry.text.trim()
    ) {
      hasText = true;
    }
  }
  return hasToolHistoryBlock && hasText;
}

export function shouldDropAssistantHistoryMessage(message: unknown): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  const entry = message as Record<string, unknown> & { role?: unknown };
  if (entry.role !== "assistant") {
    return false;
  }
  if (isProjectedSessionsSendForwardedMessage(entry)) {
    return false;
  }
  if (resolveAssistantMessagePhase(message) === "commentary") {
    return !hasAssistantMixedToolVisibleText(message);
  }
  const text = extractAssistantTextForSilentCheck(message);
  // Classify after removing UI-only directives, before sanitization can erase
  // the control token and leave a blank assistant row behind.
  const displayText =
    text === undefined ? undefined : stripInlineDirectiveTagsForDisplay(text).text;
  if (displayText === undefined || !isSuppressedControlReplyText(displayText)) {
    return false;
  }
  return !hasAssistantDisplayableNonTextContent(message);
}

export function sanitizeChatHistoryMessages(
  messages: unknown[],
  maxChars: number = DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS,
  opts?: { preserveInlineImageData?: boolean },
): unknown[] {
  if (messages.length === 0) {
    return messages;
  }
  let changed = false;
  const next: unknown[] = [];
  for (const message of messages) {
    if (shouldDropAssistantHistoryMessage(message)) {
      changed = true;
      continue;
    }
    const res = sanitizeChatHistoryMessage(message, maxChars, opts);
    changed ||= res.changed;
    if (shouldDropAssistantHistoryMessage(res.message)) {
      changed = true;
      continue;
    }
    next.push(res.message);
  }
  return changed ? next : messages;
}
