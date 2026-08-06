import { getSessionKysely } from "../../config/sessions/session-accessor.sqlite-scope.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ContextEngineHostSupport } from "../../context-engine/host-compat.js";
import type {
  ContextEngineRuntimeContext,
  ContextEngineRuntimeSettings,
  ContextEngineSessionTarget,
} from "../../context-engine/types.js";
import { executeSqliteQueryTakeFirstSync } from "../../infra/kysely-sync.js";
import type { UserTurnTranscriptAdmissionReceipt } from "../../sessions/user-turn-transcript.types.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import {
  acquireSessionWriteLock,
  resolveSessionWriteLockOptions,
  resolveSessionWriteLockTargetKey,
  type SessionWriteLockAcquireTimeoutConfig,
} from "../session-write-lock.js";
import { buildSessionContext, SessionManager } from "../sessions/index.js";
import {
  finalizeHarnessContextEngineTurn,
  runHarnessContextEngineMaintenance,
} from "./context-engine-lifecycle.js";
import type { ContextEngineLogicalTurnLease } from "./context-engine-logical-turn.js";

export type ContextEngineTurnAttemptFacts = {
  admission?: UserTurnTranscriptAdmissionReceipt;
  terminalEntryId?: string;
  terminalIdempotencyKey?: string;
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

export type ContextEngineTurnAttemptHolder = {
  facts?: ContextEngineTurnAttemptFacts;
};

function assertAcceptedTranscriptAdmission(facts: ContextEngineTurnAttemptFacts): void {
  const admission = facts.admission;
  if (!admission) {
    throw new Error("accepted context-engine turn has no transcript admission");
  }
  if (
    facts.sessionIdUsed !== admission.sessionId ||
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
  const database = openOpenClawAgentDatabase({
    agentId: admission.agentId,
    path: admission.storePath,
  });
  const db = getSessionKysely(database.db);
  const current = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("transcript_event_identities as identity")
      .innerJoin("transcript_rewrite_watermarks as rewrite", (join) =>
        join.onRef("rewrite.session_id", "=", "identity.session_id"),
      )
      .select(["identity.seq", "identity.parent_id", "rewrite.generation"])
      .where("identity.session_id", "=", admission.sessionId)
      .where("identity.event_id", "=", admission.admittedEntryId)
      .limit(1),
  );
  if (
    !current ||
    current.seq !== admission.rawSeq ||
    current.parent_id !== admission.effectiveParentId ||
    current.generation !== admission.generation
  ) {
    throw new Error("accepted context-engine transcript admission is stale");
  }
}

export async function finalizeAcceptedContextEngineTurn(params: {
  facts: ContextEngineTurnAttemptFacts;
  lease: ContextEngineLogicalTurnLease;
  warn?: (message: string) => void;
}): Promise<void> {
  const admission = params.facts.admission;
  if (!admission) {
    (params.warn ?? console.warn)(
      "[context-engine] skipped accepted turn advancement: accepted context-engine turn has no transcript admission",
    );
    return;
  }
  const target = {
    agentId: admission.agentId,
    sessionId: admission.sessionId,
    sessionKey: admission.sessionKey,
    storePath: admission.storePath,
  };
  let lock: Awaited<ReturnType<typeof acquireSessionWriteLock>> | undefined;
  try {
    lock = await acquireSessionWriteLock({
      sessionFile: resolveSessionWriteLockTargetKey(target),
      targetKind: "session-key",
      ...resolveSessionWriteLockOptions(params.facts.config),
    });
    assertAcceptedTranscriptAdmission(params.facts);
    const sessionManager = SessionManager.open(target);
    const terminalEntryId =
      params.facts.terminalEntryId ??
      sessionManager
        .getEntries()
        .find(
          (entry) =>
            entry.type === "message" &&
            (entry.message as { idempotencyKey?: unknown }).idempotencyKey ===
              params.facts.terminalIdempotencyKey,
        )?.id;
    if (!terminalEntryId) {
      throw new Error("accepted context-engine terminal entry is unavailable");
    }
    const admittedEntry = sessionManager.getEntry(admission.admittedEntryId);
    const branchIds = new Set(sessionManager.getBranch(terminalEntryId).map((entry) => entry.id));
    if (
      !admittedEntry ||
      admittedEntry.type !== "message" ||
      admittedEntry.message.role !== "user" ||
      !sessionManager.getEntry(terminalEntryId) ||
      !branchIds.has(admission.admittedEntryId)
    ) {
      throw new Error("accepted context-engine transcript range is unavailable");
    }
    const entries = sessionManager.getEntries();
    await finalizeHarnessContextEngineTurn({
      contextEngine: params.lease.engine,
      promptError: params.facts.promptError,
      aborted: params.facts.aborted,
      yieldAborted: params.facts.yieldAborted,
      sessionIdUsed: params.facts.sessionIdUsed,
      sessionKey: params.facts.sessionKey,
      sessionTarget: target,
      sessionFile: params.facts.sessionFile,
      messagesSnapshot: buildSessionContext(entries, terminalEntryId).messages,
      prePromptMessageCount: buildSessionContext(entries, admittedEntry.parentId).messages.length,
      tokenBudget: params.facts.tokenBudget,
      runtimeContext: params.facts.runtimeContext,
      runtimeSettings: params.facts.runtimeSettings,
      contextEngineHostSupport: params.facts.contextEngineHostSupport,
      harnessId: params.facts.harnessId,
      runtimeId: params.facts.runtimeId,
      providerId: params.facts.providerId,
      requestedModelId: params.facts.requestedModelId,
      modelId: params.facts.modelId,
      maxOutputTokens: params.facts.maxOutputTokens,
      fallbackReason: params.facts.fallbackReason,
      degradedReason: params.facts.degradedReason,
      sessionManager,
      runMaintenance: async (maintenanceParams) =>
        await runHarnessContextEngineMaintenance({
          ...maintenanceParams,
          onDeferredMaintenance: (promise) => params.lease.deferDisposalUntil(promise),
        }),
      config: params.facts.config,
      warn: params.warn ?? console.warn,
      isHeartbeat: params.facts.isHeartbeat,
    });
  } catch (error) {
    (params.warn ?? console.warn)(
      `[context-engine] skipped accepted turn advancement: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    await lock?.release();
  }
}
