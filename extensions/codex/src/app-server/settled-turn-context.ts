import {
  embeddedAgentLog,
  formatErrorMessage,
  type AgentMessage,
  type EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { parseSqliteSessionFileMarker } from "openclaw/plugin-sdk/session-store-runtime";
import type { EmbeddedRunAttemptResult } from "./attempt-terminal.js";
import { readCodexMirroredSessionHistoryMessages } from "./session-history.js";
import { serializeCodexMirrorSourceEvidence } from "./transcript-mirror-attestation.js";
import { readMirrorIdentity } from "./upstream-prompt-provenance.js";

type SettledTurnFinalizationContext = EmbeddedRunAttemptResult["settledTurnFinalizationContext"];

type MessageIdentityIndex =
  | { identities: Map<string, number>; duplicateIdentity?: never }
  | { identities?: never; duplicateIdentity: string };

function collectUniqueMessageIdentities(messages: readonly AgentMessage[]): MessageIdentityIndex {
  const identities = new Map<string, number>();
  for (const [index, message] of messages.entries()) {
    const identity = readMirrorIdentity(message);
    if (!identity) {
      continue;
    }
    if (identities.has(identity)) {
      return { duplicateIdentity: identity };
    }
    identities.set(identity, index);
  }
  return { identities };
}

/** Freezes one complete active transcript branch through the settled tool-result boundary. */
function buildCodexSettledTurnFinalizationContext(params: {
  historyMessages: readonly AgentMessage[];
  mirroredMessages: readonly AgentMessage[];
  settledMessages: readonly AgentMessage[];
  turnId: string;
  reportOutcome?: (outcome: string, stage?: string, messageCount?: number) => void;
}): SettledTurnFinalizationContext | undefined {
  const boundaryMessage = params.settledMessages.findLast(
    (message) => message.role === "toolResult",
  );
  const boundaryIdentity = boundaryMessage ? readMirrorIdentity(boundaryMessage) : undefined;
  if (
    !boundaryMessage ||
    !boundaryIdentity ||
    !boundaryIdentity.startsWith(`${params.turnId}:tool:`)
  ) {
    params.reportOutcome?.("invalid_tool_boundary", "context_validation");
    return undefined;
  }

  const settledBoundaryIndex = params.settledMessages.indexOf(boundaryMessage);
  const requiredIdentities = params.settledMessages
    .slice(0, settledBoundaryIndex + 1)
    .map(readMirrorIdentity);
  if (
    requiredIdentities.length === 0 ||
    requiredIdentities.some((identity) => !identity) ||
    new Set(requiredIdentities).size !== requiredIdentities.length ||
    !requiredIdentities.includes(`${params.turnId}:prompt`)
  ) {
    params.reportOutcome?.("invalid_required_identities", "context_validation");
    return undefined;
  }

  const historyIdentityIndex = collectUniqueMessageIdentities(params.historyMessages);
  if (historyIdentityIndex.duplicateIdentity !== undefined) {
    params.reportOutcome?.("duplicate_history_identity", "context_validation");
    return undefined;
  }
  const mirroredIdentityIndex = collectUniqueMessageIdentities(params.mirroredMessages);
  if (mirroredIdentityIndex.duplicateIdentity !== undefined) {
    params.reportOutcome?.("duplicate_mirrored_identity", "context_validation");
    return undefined;
  }
  const historyIdentities = historyIdentityIndex.identities;
  const mirroredIdentities = mirroredIdentityIndex.identities;
  const mirroredBoundaryIndex = mirroredIdentities.get(boundaryIdentity);
  if (mirroredBoundaryIndex === undefined) {
    params.reportOutcome?.("missing_mirrored_boundary", "context_validation");
    return undefined;
  }
  const mirroredThroughBoundary = params.mirroredMessages.slice(0, mirroredBoundaryIndex + 1);
  if (
    mirroredThroughBoundary.length !== requiredIdentities.length ||
    mirroredThroughBoundary.some(
      (message, index) => readMirrorIdentity(message) !== requiredIdentities[index],
    )
  ) {
    params.reportOutcome?.("mirrored_sequence_mismatch", "context_validation");
    return undefined;
  }
  const historyBoundaryIndex = historyIdentities.get(boundaryIdentity);
  if (historyBoundaryIndex === undefined) {
    params.reportOutcome?.("missing_history_boundary", "context_validation");
    return undefined;
  }
  let previousHistoryIndex = -1;
  for (const mirroredMessage of mirroredThroughBoundary) {
    const identity = readMirrorIdentity(mirroredMessage);
    const historyIndex = identity ? historyIdentities.get(identity) : undefined;
    const historyMessage =
      historyIndex === undefined ? undefined : params.historyMessages[historyIndex];
    if (
      historyIndex === undefined ||
      historyIndex <= previousHistoryIndex ||
      historyIndex > historyBoundaryIndex ||
      !historyMessage ||
      serializeCodexMirrorSourceEvidence(historyMessage) !==
        serializeCodexMirrorSourceEvidence(mirroredMessage)
    ) {
      params.reportOutcome?.("history_evidence_mismatch", "context_validation");
      return undefined;
    }
    previousHistoryIndex = historyIndex;
  }

  // Clone before returning so later transcript/cache mutation cannot change the
  // exact application evidence authorized for the isolated finalization turn.
  const cloneMessageCount = historyBoundaryIndex + 1;
  params.reportOutcome?.("started", "settled_context_clone", cloneMessageCount);
  const messages = Object.freeze(
    structuredClone(params.historyMessages.slice(0, historyBoundaryIndex + 1)),
  );
  params.reportOutcome?.("completed", "settled_context_clone", cloneMessageCount);
  params.reportOutcome?.("captured", "context_validation", cloneMessageCount);
  return { source: "openclaw-transcript", messages };
}

/** Reads and freezes the current active transcript branch after mirroring has settled. */
export async function captureCodexSettledTurnFinalizationContext(params: {
  agentId?: string;
  sessionFile: string;
  sessionId: string;
  sessionKey?: string;
  mirroredMessages: readonly AgentMessage[];
  settledMessages: readonly AgentMessage[];
  turnId: string;
  onExecutionPhase?: EmbeddedRunAttemptParams["onExecutionPhase"];
}): Promise<SettledTurnFinalizationContext | undefined> {
  const captureStartedAt = performance.now();
  const reportOutcome = (outcome: string, stage?: string, messageCount?: number) => {
    params.onExecutionPhase?.({
      phase: "session_materialization_checkpoint",
      backend: parseCodexTranscriptBackend(params.sessionFile),
      purpose: "settled_turn_finalization",
      stage,
      outcome,
      messageCount,
      durationMs: performance.now() - captureStartedAt,
    });
  };
  try {
    const historyMessages = await readCodexMirroredSessionHistoryMessages({
      ...params,
      purpose: "settled_turn_finalization",
    });
    if (!historyMessages) {
      reportOutcome("history_unavailable", "context_validation");
      return undefined;
    }
    return buildCodexSettledTurnFinalizationContext({
      historyMessages,
      mirroredMessages: params.mirroredMessages,
      settledMessages: params.settledMessages,
      turnId: params.turnId,
      reportOutcome,
    });
  } catch (error) {
    // Capture runs after tools have settled. Never let transcript I/O or cloning
    // bypass the caller's side-effect-aware incomplete-turn result.
    reportOutcome("capture_exception", "context_validation");
    embeddedAgentLog.warn("codex settled-turn finalization context capture failed", {
      error: formatErrorMessage(error),
      turnId: params.turnId,
    });
    return undefined;
  }
}

function parseCodexTranscriptBackend(sessionFile: string): string {
  return parseSqliteSessionFileMarker(sessionFile) ? "sqlite" : "jsonl";
}
