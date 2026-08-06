import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { UserTurnTranscriptAdmissionReceipt } from "../../sessions/user-turn-transcript.types.js";
import { resolveRuntimeTranscriptReadTarget } from "../embedded-agent-runner/transcript-runtime-state.js";
import type { AgentMessage } from "../runtime/index.js";
import {
  acquireSessionWriteLock,
  resolveSessionWriteLockOptions,
  resolveSessionWriteLockTargetKey,
} from "../session-write-lock.js";
import { buildSessionContext, SessionManager } from "../sessions/index.js";

type ContextEngineTurnTranscript = {
  messagesSnapshot: AgentMessage[];
  prePromptMessageCount: number;
  sessionManager?: SessionManager;
  withSessionManagerRewriteLock: <T>(operation: () => Promise<T> | T) => Promise<T>;
};

type ContextEngineTurnTranscriptParams = {
  admissionReceipt?: UserTurnTranscriptAdmissionReceipt;
  sessionFile: string;
  config?: OpenClawConfig;
  fallbackMessagesSnapshot: AgentMessage[];
  fallbackPrePromptMessageCount: number;
};

export type ContextEngineTurnSettlement = {
  commit: () => Promise<void>;
  discard: () => void;
  dispose: () => Promise<void>;
  holdDisposalUntil: (promise: Promise<void>) => void;
  setFinalizer: (finalizer: () => Promise<void>) => void;
  withTranscript: (
    params: ContextEngineTurnTranscriptParams,
    run: (transcript: ContextEngineTurnTranscript) => Promise<void>,
  ) => Promise<void>;
};

async function withAcceptedTurnTranscript(
  params: ContextEngineTurnTranscriptParams,
  run: (transcript: ContextEngineTurnTranscript) => Promise<void>,
): Promise<void> {
  if (!params.admissionReceipt) {
    await run({
      messagesSnapshot: params.fallbackMessagesSnapshot,
      prePromptMessageCount: params.fallbackPrePromptMessageCount,
      withSessionManagerRewriteLock: async (operation) => await operation(),
    });
    return;
  }
  const target = await resolveRuntimeTranscriptReadTarget({
    ...params.admissionReceipt.target,
    sessionFile: params.sessionFile,
  });
  const lock = await acquireSessionWriteLock({
    sessionFile: resolveSessionWriteLockTargetKey(target),
    targetKind: "session-key",
    ...resolveSessionWriteLockOptions(params.config),
  });
  try {
    const sessionManager = SessionManager.open(target);
    const admittedEntry = sessionManager.getEntry(params.admissionReceipt.messageId);
    if (!admittedEntry) {
      throw new Error(
        `Accepted context-engine turn admission is missing: ${params.admissionReceipt.messageId}`,
      );
    }
    await run({
      messagesSnapshot: sessionManager.buildSessionContext().messages,
      prePromptMessageCount: buildSessionContext(
        sessionManager.getEntries(),
        admittedEntry.parentId,
      ).messages.length,
      sessionManager,
      withSessionManagerRewriteLock: async (operation) => await operation(),
    });
  } finally {
    await lock.release();
  }
}

/** Creates one candidate-scoped context-engine settlement owned by model fallback. */
export function createContextEngineTurnSettlement(params: {
  dispose: () => Promise<void>;
}): ContextEngineTurnSettlement {
  let decision: "pending" | "committed" | "discarded" = "pending";
  let disposed = false;
  let finalizer: (() => Promise<void>) | undefined;
  const disposalHolds = new Set<Promise<void>>();
  return {
    withTranscript: withAcceptedTurnTranscript,
    holdDisposalUntil(promise) {
      disposalHolds.add(promise);
      void promise.finally(() => disposalHolds.delete(promise)).catch(() => {});
    },
    setFinalizer(nextFinalizer) {
      if (decision !== "pending") {
        throw new Error(`Context-engine turn is already ${decision}`);
      }
      if (finalizer) {
        throw new Error("Context-engine turn finalizer is already registered");
      }
      finalizer = nextFinalizer;
    },
    async commit() {
      if (decision === "committed") {
        return;
      }
      if (decision === "discarded") {
        throw new Error("Cannot commit a discarded context-engine turn");
      }
      decision = "committed";
      await finalizer?.();
    },
    discard() {
      if (decision === "pending") {
        decision = "discarded";
      }
    },
    async dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      if (decision === "pending") {
        decision = "discarded";
      }
      await Promise.allSettled(disposalHolds);
      await params.dispose();
    },
  };
}
