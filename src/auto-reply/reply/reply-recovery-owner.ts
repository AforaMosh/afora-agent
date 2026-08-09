import { repairMainSessionRecoveryMutation } from "../../agents/main-session-recovery-lifecycle.js";
import { abortMainSessionRecoveryOwner } from "../../agents/main-session-recovery-owner-abort.js";
import type { MainSessionRecoveryOwnerLease } from "../../agents/main-session-recovery-store.js";
import type { InternalSessionEntry } from "../../config/sessions.js";
import { logVerbose } from "../../globals.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createDeferred } from "../../shared/deferred.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { resolveReplyOperationRunId } from "./reply-operation-run-id.js";
import type { ReplyOperation } from "./reply-run-registry.js";

const recoveryOwnersByOperation = resolveGlobalSingleton(
  Symbol.for("openclaw.replyRecoveryOwnersByOperation"),
  () => new WeakMap<ReplyOperation, Set<MainSessionRecoveryOwnerLease>>(),
);

const abortPersistenceByOperation = resolveGlobalSingleton(
  Symbol.for("openclaw.replyRecoveryAbortPersistenceByOperation"),
  () => new WeakMap<ReplyOperation, Set<Promise<void>>>(),
);

type ReplyRecoveryOwnerAbortResult =
  | { kind: "applied"; entry: InternalSessionEntry; sessionKey: string }
  | { kind: "owner_changed" };

type ReplyRecoveryOwnerAbortAttempt =
  | ReplyRecoveryOwnerAbortResult
  | { kind: "persistence_failed"; error: string };

type ReplyRecoveryAbortResult = {
  recoveries: Array<Extract<ReplyRecoveryOwnerAbortResult, { kind: "applied" }>>;
  persistenceErrors: string[];
};

function addAbortPersistenceBarrier(operation: ReplyOperation, barrier: Promise<void>): void {
  const barriers = abortPersistenceByOperation.get(operation) ?? new Set<Promise<void>>();
  barriers.add(barrier);
  abortPersistenceByOperation.set(operation, barriers);
  void barrier.then(() => {
    barriers.delete(barrier);
    if (barriers.size === 0) {
      abortPersistenceByOperation.delete(operation);
    }
  });
}

export function setReplyRecoveryOwner(
  operation: ReplyOperation,
  lease: MainSessionRecoveryOwnerLease,
): void {
  const leases =
    recoveryOwnersByOperation.get(operation) ?? new Set<MainSessionRecoveryOwnerLease>();
  leases.add(lease);
  recoveryOwnersByOperation.set(operation, leases);
}

export function clearReplyRecoveryOwner(
  operation: ReplyOperation,
  lease: MainSessionRecoveryOwnerLease,
): void {
  const leases = recoveryOwnersByOperation.get(operation);
  if (!leases) {
    return;
  }
  leases.delete(lease);
  if (leases.size === 0) {
    recoveryOwnersByOperation.delete(operation);
  }
}

/** Keeps owner release behind any accepted user-abort persistence. */
export async function waitForReplyRecoveryAbortPersistence(
  operation: ReplyOperation,
): Promise<void> {
  while (true) {
    const barriers = [...(abortPersistenceByOperation.get(operation) ?? [])];
    if (barriers.length === 0) {
      return;
    }
    await Promise.all(barriers);
  }
}

function startRecoveryOwnerAbort(
  lease: MainSessionRecoveryOwnerLease,
  runId: string | undefined,
): {
  initial: Promise<ReplyRecoveryOwnerAbortAttempt>;
  settled: Promise<void>;
} {
  const initial = createDeferred<ReplyRecoveryOwnerAbortAttempt>();
  const settled = createDeferred();
  let initialResolved = false;
  const resolveInitial = (result: ReplyRecoveryOwnerAbortAttempt) => {
    if (!initialResolved) {
      initialResolved = true;
      initial.resolve(result);
    }
  };
  void repairMainSessionRecoveryMutation({
    mutation: () => abortMainSessionRecoveryOwner(lease, runId),
    onError: (error) => {
      resolveInitial({ kind: "persistence_failed", error: formatErrorMessage(error) });
    },
    onDeferredSuccess: (result) => {
      resolveInitial(result);
      settled.resolve();
    },
  }).then((result) => {
    if (!result) {
      return;
    }
    resolveInitial(result);
    settled.resolve();
  });
  return { initial: initial.promise, settled: settled.promise };
}

/**
 * Registers the release barrier before backend cancellation can synchronously
 * complete the reply operation. Persistence starts only after abort acceptance.
 */
function prepareReplyRecoveryUserAbort(operation: ReplyOperation):
  | {
      commit(): void;
      reject(): void;
      result: Promise<ReplyRecoveryAbortResult>;
    }
  | undefined {
  const leases = [...(recoveryOwnersByOperation.get(operation) ?? [])];
  if (leases.length === 0) {
    return undefined;
  }
  const runId = resolveReplyOperationRunId(operation);
  const initial = createDeferred<ReplyRecoveryAbortResult>();
  const settled = createDeferred();
  addAbortPersistenceBarrier(operation, settled.promise);
  let decided = false;
  return {
    result: initial.promise,
    commit() {
      if (decided) {
        return;
      }
      decided = true;
      const attempts = leases.map((lease) => startRecoveryOwnerAbort(lease, runId));
      void Promise.all(attempts.map((attempt) => attempt.initial)).then((results) => {
        initial.resolve({
          recoveries: results.filter(
            (result): result is Extract<ReplyRecoveryOwnerAbortResult, { kind: "applied" }> =>
              result.kind === "applied",
          ),
          persistenceErrors: results.flatMap((result) =>
            result.kind === "persistence_failed" ? [result.error] : [],
          ),
        });
      });
      void Promise.all(attempts.map((attempt) => attempt.settled)).then(() => settled.resolve());
    },
    reject() {
      if (decided) {
        return;
      }
      decided = true;
      initial.resolve({ recoveries: [], persistenceErrors: [] });
      settled.resolve();
    },
  };
}

export async function runReplyRecoveryUserAbort<T extends { aborted: boolean }>(params: {
  operation: ReplyOperation | undefined;
  abort: () => T;
  logLabel: string;
}): Promise<
  T & {
    recoveries?: Array<Extract<ReplyRecoveryOwnerAbortResult, { kind: "applied" }>>;
  }
> {
  const recoveryAbort = params.operation
    ? prepareReplyRecoveryUserAbort(params.operation)
    : undefined;
  const settleRecoveryAbort = async (accepted: boolean) => {
    if (!recoveryAbort) {
      return undefined;
    }
    if (accepted) {
      recoveryAbort.commit();
    } else {
      recoveryAbort.reject();
    }
    const recovery = await recoveryAbort.result;
    for (const error of recovery.persistenceErrors) {
      logVerbose(`abort: failed to persist recovery abort for ${params.logLabel}: ${error}`);
    }
    return recovery.recoveries;
  };

  let outcome: T;
  try {
    outcome = params.abort();
  } catch (error) {
    const operationResult = params.operation?.result;
    await settleRecoveryAbort(
      operationResult?.kind === "aborted" && operationResult.code === "aborted_by_user",
    );
    throw error;
  }

  const recoveries = await settleRecoveryAbort(outcome.aborted);
  return recoveries?.length ? { ...outcome, recoveries } : outcome;
}
