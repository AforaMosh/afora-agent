import { repairMainSessionRecoveryMutation } from "../../agents/main-session-recovery-lifecycle.js";
import {
  abortMainSessionRecoveryOwner,
  abortMainSessionRecoveryRun,
  type MainSessionRecoveryOwnerAbortResult,
  type MainSessionRecoveryOwnerLease,
  type MainSessionRecoveryStoreTarget,
} from "../../agents/main-session-recovery-store.js";
import type { MainSessionRecoveryRunIdentity } from "../../agents/main-session-recovery-types.js";
import { logVerbose } from "../../globals.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createDeferred } from "../../shared/deferred.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { resolveReplyOperationRunId, type ReplyOperation } from "./reply-run-registry.js";

const recoveryOwnersByOperation = resolveGlobalSingleton(
  Symbol.for("openclaw.replyRecoveryOwnersByOperation"),
  () => new WeakMap<ReplyOperation, Set<MainSessionRecoveryOwnerLease>>(),
);

const abortPersistenceByOperation = resolveGlobalSingleton(
  Symbol.for("openclaw.replyRecoveryAbortPersistenceByOperation"),
  () => new WeakMap<ReplyOperation, Set<Promise<void>>>(),
);

type ReplyRecoveryOwnerAbortResult = MainSessionRecoveryOwnerAbortResult;

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

function startRecoveryOwnerAbort(mutation: () => Promise<ReplyRecoveryOwnerAbortResult>): {
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
    mutation,
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
      const attempts = leases.map((lease) =>
        startRecoveryOwnerAbort(() => abortMainSessionRecoveryOwner(lease, runId)),
      );
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

type ReplyRecoveryRunTarget = MainSessionRecoveryRunIdentity & MainSessionRecoveryStoreTarget;

function prepareReplyRecoveryRunAbort(target: ReplyRecoveryRunTarget): {
  commit(): void;
  reject(): void;
  result: Promise<ReplyRecoveryAbortResult>;
} {
  const initial = createDeferred<ReplyRecoveryAbortResult>();
  let decided = false;
  return {
    result: initial.promise,
    commit() {
      if (decided) {
        return;
      }
      decided = true;
      const attempt = startRecoveryOwnerAbort(() => abortMainSessionRecoveryRun(target));
      void attempt.initial.then((result) => {
        initial.resolve({
          recoveries: result.kind === "applied" ? [result] : [],
          persistenceErrors: result.kind === "persistence_failed" ? [result.error] : [],
        });
      });
    },
    reject() {
      if (decided) {
        return;
      }
      decided = true;
      initial.resolve({ recoveries: [], persistenceErrors: [] });
    },
  };
}

export async function runReplyRecoveryUserAbort<T extends { aborted: boolean }>(params: {
  operation: ReplyOperation | undefined;
  recoveryRun?: ReplyRecoveryRunTarget;
  abort: () => T | Promise<T>;
  logLabel: string;
}): Promise<
  T & {
    recoveries?: Array<Extract<ReplyRecoveryOwnerAbortResult, { kind: "applied" }>>;
    recoveryPersistenceErrors?: string[];
  }
> {
  const recoveryAbort =
    (params.operation ? prepareReplyRecoveryUserAbort(params.operation) : undefined) ??
    (params.recoveryRun ? prepareReplyRecoveryRunAbort(params.recoveryRun) : undefined);
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
    return recovery;
  };

  let outcome: T;
  try {
    outcome = await params.abort();
  } catch (error) {
    const operationResult = params.operation?.result;
    await settleRecoveryAbort(
      operationResult?.kind === "aborted" && operationResult.code === "aborted_by_user",
    );
    throw error;
  }

  const recovery = await settleRecoveryAbort(outcome.aborted);
  return {
    ...outcome,
    ...(recovery?.recoveries.length ? { recoveries: recovery.recoveries } : {}),
    ...(recovery?.persistenceErrors.length
      ? { recoveryPersistenceErrors: recovery.persistenceErrors }
      : {}),
  };
}
