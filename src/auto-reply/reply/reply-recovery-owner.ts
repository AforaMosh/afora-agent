import { repairMainSessionRecoveryMutation } from "../../agents/main-session-recovery-lifecycle.js";
import {
  abortMainSessionRecoveryOwner,
  type MainSessionRecoveryOwnerLease,
} from "../../agents/main-session-recovery-store.js";
import type { InternalSessionEntry } from "../../config/sessions.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createDeferred } from "../../shared/deferred.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { resolveReplyOperationRunId, type ReplyOperation } from "./reply-run-registry.js";

const recoveryOwnerByOperation = resolveGlobalSingleton(
  Symbol.for("openclaw.replyRecoveryOwnerByOperation"),
  () => new WeakMap<ReplyOperation, MainSessionRecoveryOwnerLease>(),
);

const abortPersistenceByOperation = resolveGlobalSingleton(
  Symbol.for("openclaw.replyRecoveryAbortPersistenceByOperation"),
  () => new WeakMap<ReplyOperation, Set<Promise<void>>>(),
);

type ReplyRecoveryAbortResult =
  | { kind: "applied"; entry: InternalSessionEntry; sessionKey: string }
  | { kind: "owner_changed" }
  | { kind: "persistence_failed"; error: string };

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
  lease: MainSessionRecoveryOwnerLease | undefined,
): void {
  if (lease) {
    recoveryOwnerByOperation.set(operation, lease);
  } else {
    recoveryOwnerByOperation.delete(operation);
  }
}

export function clearReplyRecoveryOwner(
  operation: ReplyOperation,
  lease: MainSessionRecoveryOwnerLease,
): void {
  if (recoveryOwnerByOperation.get(operation) === lease) {
    recoveryOwnerByOperation.delete(operation);
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

/**
 * Registers the release barrier before backend cancellation can synchronously
 * complete the reply operation. Persistence starts only after abort acceptance.
 */
export function prepareReplyRecoveryUserAbort(operation: ReplyOperation):
  | {
      commit(): void;
      reject(): void;
      result: Promise<ReplyRecoveryAbortResult>;
    }
  | undefined {
  const lease = recoveryOwnerByOperation.get(operation);
  if (!lease) {
    return undefined;
  }
  const runId = resolveReplyOperationRunId(operation);
  const initial = createDeferred<ReplyRecoveryAbortResult>();
  const settled = createDeferred();
  addAbortPersistenceBarrier(operation, settled.promise);
  let decided = false;
  let initialResolved = false;
  const resolveInitial = (result: ReplyRecoveryAbortResult) => {
    if (!initialResolved) {
      initialResolved = true;
      initial.resolve(result);
    }
  };
  return {
    result: initial.promise,
    commit() {
      if (decided) {
        return;
      }
      decided = true;
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
    },
    reject() {
      if (decided) {
        return;
      }
      decided = true;
      resolveInitial({ kind: "owner_changed" });
      settled.resolve();
    },
  };
}
