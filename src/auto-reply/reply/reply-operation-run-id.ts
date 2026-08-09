import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { ReplyOperation } from "./reply-run-registry.js";

const backendRunIdByOperation = new WeakMap<ReplyOperation, string>();

export function setReplyOperationRunId(operation: ReplyOperation, runId: string | undefined): void {
  const normalized = normalizeOptionalString(runId);
  if (normalized) {
    backendRunIdByOperation.set(operation, normalized);
  } else {
    backendRunIdByOperation.delete(operation);
  }
}

export function clearReplyOperationRunId(operation: ReplyOperation): void {
  backendRunIdByOperation.delete(operation);
}

export function resolveReplyOperationRunId(operation: ReplyOperation): string | undefined {
  return backendRunIdByOperation.get(operation);
}
