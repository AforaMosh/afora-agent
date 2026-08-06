import {
  readClosedTranscriptTurn,
  type TranscriptTurnBoundary,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ContextEngineHostSupport } from "../../context-engine/host-compat.js";
import type {
  ContextEngineRuntimeContext,
  ContextEngineRuntimeSettings,
  ContextEngineSessionTarget,
} from "../../context-engine/types.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type { SessionWriteLockAcquireTimeoutConfig } from "../session-write-lock.js";
import type { ContextEngineLogicalTurnLease } from "./context-engine-logical-turn.js";
import {
  drainContextEngineTurnOutbox,
  enqueueContextEngineTurnCommit,
} from "./context-engine-turn-outbox.js";

const ACCEPTED_TURN_MAX_EVENTS = 20_000;
const ACCEPTED_TURN_MAX_BYTES = 8 * 1024 * 1024;

export type ContextEngineTurnAttemptFacts = {
  boundary: TranscriptTurnBoundary;
  sessionIdUsed: string;
  sessionKey?: string;
  sessionTarget?: ContextEngineSessionTarget;
  sessionFile: string;
  promptError: boolean;
  aborted: boolean;
  yieldAborted: boolean;
  tokenBudget?: number;
  runtimeContext?: ContextEngineRuntimeContext;
  runtimeSettings?: ContextEngineRuntimeSettings;
  contextEngineHostSupport?: ContextEngineHostSupport;
  harnessId?: string | null;
  runtimeId?: string | null;
  providerId?: string | null;
  requestedModelId?: string | null;
  modelId?: string | null;
  maxOutputTokens?: number | null;
  fallbackReason?: string | null;
  degradedReason?: string | null;
  config?: OpenClawConfig & SessionWriteLockAcquireTimeoutConfig;
  isHeartbeat?: boolean;
};

export async function drainPendingContextEngineTurnsBeforeRun(params: {
  admission: TranscriptTurnBoundary["admission"] | undefined;
  lease: ContextEngineLogicalTurnLease;
  warn?: (message: string) => void;
}): Promise<void> {
  if (
    !params.admission ||
    params.lease.degraded ||
    params.lease.engine.info.transcriptSemantics?.turnAdvancementIdempotency !==
      "atomic-idempotent-v1" ||
    typeof params.lease.engine.commitTurn !== "function"
  ) {
    return;
  }
  const warn = params.warn ?? console.warn;
  try {
    const database = openOpenClawAgentDatabase({
      agentId: params.admission.agentId,
      path: params.admission.storePath,
    });
    const result = await drainContextEngineTurnOutbox({
      database,
      engine: params.lease.engine,
      engineId: params.lease.effectiveEngineId,
      ownerPluginId: params.lease.effectiveEnginePluginId,
      sessionId: params.admission.sessionId,
      warn,
    });
    if (result.pending) {
      params.lease.degradeBeforeStart(
        "pending durable turn advancement could not be completed before the next turn",
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warn(`[context-engine] failed to retry pending turn advancement: ${message}`);
    params.lease.degradeBeforeStart(
      "pending durable turn advancement could not be checked before the next turn",
    );
  }
}

function assertAcceptedTranscriptTarget(facts: ContextEngineTurnAttemptFacts): void {
  const { admission, terminal } = facts.boundary;
  if (
    facts.sessionIdUsed !== admission.sessionId ||
    terminal.agentId !== admission.agentId ||
    terminal.sessionId !== admission.sessionId ||
    terminal.sessionKey !== admission.sessionKey ||
    terminal.storePath !== admission.storePath ||
    (facts.sessionKey !== undefined && facts.sessionKey !== admission.sessionKey) ||
    (facts.sessionTarget?.agentId !== undefined &&
      facts.sessionTarget.agentId !== admission.agentId) ||
    (facts.sessionTarget?.sessionId !== undefined &&
      facts.sessionTarget.sessionId !== admission.sessionId) ||
    (facts.sessionTarget?.sessionKey !== undefined &&
      facts.sessionTarget.sessionKey !== admission.sessionKey)
  ) {
    throw new Error("accepted context-engine transcript target changed after admission");
  }
}

export async function finalizeAcceptedContextEngineTurn(params: {
  facts: ContextEngineTurnAttemptFacts;
  lease: ContextEngineLogicalTurnLease;
  warn?: (message: string) => void;
}): Promise<void> {
  if (params.facts.promptError || params.facts.aborted || params.facts.yieldAborted) {
    return;
  }
  const warn = params.warn ?? console.warn;
  try {
    assertAcceptedTranscriptTarget(params.facts);
    if (
      params.lease.degraded ||
      params.lease.engine.info.transcriptSemantics?.turnAdvancementIdempotency !==
        "atomic-idempotent-v1" ||
      typeof params.lease.engine.commitTurn !== "function"
    ) {
      throw new Error("accepted context engine does not support durable turn advancement");
    }
    const closedTurn = readClosedTranscriptTurn({
      boundary: params.facts.boundary,
      maxEvents: ACCEPTED_TURN_MAX_EVENTS,
      maxBytes: ACCEPTED_TURN_MAX_BYTES,
    });
    if (closedTurn.kind !== "ok") {
      throw new Error(`accepted context-engine transcript range is ${closedTurn.kind}`);
    }
    const admission = params.facts.boundary.admission;
    const database = openOpenClawAgentDatabase({
      agentId: admission.agentId,
      path: admission.storePath,
    });
    enqueueContextEngineTurnCommit({
      database,
      engineId: params.lease.effectiveEngineId,
      ownerPluginId: params.lease.effectiveEnginePluginId,
      payload: {
        boundary: params.facts.boundary,
        isHeartbeat: params.facts.isHeartbeat === true,
        messages: closedTurn.messages,
        prePromptMessageCount: closedTurn.prePromptMessageCount,
        sessionId: params.facts.sessionIdUsed,
        ...(params.facts.sessionKey ? { sessionKey: params.facts.sessionKey } : {}),
      },
    });
    await drainContextEngineTurnOutbox({
      database,
      engine: params.lease.engine,
      engineId: params.lease.effectiveEngineId,
      ownerPluginId: params.lease.effectiveEnginePluginId,
      warn,
    });
  } catch (error) {
    warn(
      `[context-engine] skipped accepted turn advancement: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
