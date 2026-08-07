import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { CodexThread } from "./protocol.js";
import {
  hasLegacyCodexNativeMcpBinding,
  type CodexAppServerBindingStore,
  type CodexAppServerThreadBinding,
} from "./session-binding.js";

const MAX_LEGACY_LINEAGE_DEPTH = 64;
const MAX_THREAD_ID_LENGTH = 256;

/** Validates the minimum protocol shape required for ancestry enforcement. */
export function assertCodexThreadReadResult(value: unknown): CodexThread {
  if (!isRecord(value) || !isRecord(value.thread) || !readThreadId(value.thread.id)) {
    throw new Error("Codex returned an invalid thread/read response while checking lineage");
  }
  return value.thread as CodexThread;
}

function readThreadId(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized && normalized.length <= MAX_THREAD_ID_LENGTH ? normalized : undefined;
}

function readSpawnParentThreadId(thread: CodexThread): string | undefined {
  const directParentThreadId = readThreadId(thread.parentThreadId);
  const source = thread.source;
  if (!source || typeof source !== "object" || !("subAgent" in source)) {
    return directParentThreadId;
  }
  const subAgent = source.subAgent;
  const sourceParentThreadId =
    subAgent && typeof subAgent === "object" && "thread_spawn" in subAgent
      ? readThreadId(subAgent.thread_spawn.parent_thread_id)
      : undefined;
  if (
    directParentThreadId &&
    sourceParentThreadId &&
    directParentThreadId !== sourceParentThreadId
  ) {
    throw new Error(`Codex thread ${thread.id} returned conflicting configured MCP parent lineage`);
  }
  const parentThreadId = directParentThreadId ?? sourceParentThreadId;
  if (!parentThreadId) {
    throw new Error(
      `Codex thread ${thread.id} has unverifiable subagent ancestry and cannot re-enter while retired configured MCP authority exists`,
    );
  }
  return parentThreadId;
}

/**
 * Preserved legacy roots can keep spawning native descendants outside OpenClaw.
 * Follow immutable spawn provenance so no descendant can re-enter with inherited stale MCP.
 */
export async function assertNoRetiredLegacyMcpThreadLineage(params: {
  bindingStore: CodexAppServerBindingStore;
  threadId: string;
  readThread: (threadId: string) => Promise<CodexThread>;
  initialThread?: CodexThread;
}): Promise<void> {
  if (!(await params.bindingStore.hasLegacyMcpRetirementState())) {
    return;
  }
  const startThreadId = readThreadId(params.threadId);
  if (!startThreadId) {
    throw new Error("cannot verify configured MCP lineage for an invalid Codex thread id");
  }

  const seen = new Set<string>();
  let threadId: string | undefined = startThreadId;
  let thread = params.initialThread;
  for (let depth = 0; threadId && depth < MAX_LEGACY_LINEAGE_DEPTH; depth += 1) {
    if (seen.has(threadId)) {
      throw new Error("Codex returned a cyclic configured MCP thread lineage");
    }
    seen.add(threadId);
    if ((await params.bindingStore.inspectThreadOwnership(threadId)).hasLegacyNativeMcpOwner) {
      throw new Error(
        `Codex thread ${startThreadId} descends from retired configured MCP authority and cannot be resumed or forked by OpenClaw`,
      );
    }
    const current = thread ?? (await params.readThread(threadId));
    thread = undefined;
    if (current.id !== threadId) {
      throw new Error("Codex returned a different thread while checking configured MCP lineage");
    }
    threadId = readSpawnParentThreadId(current);
  }
  if (threadId) {
    throw new Error("Codex configured MCP thread lineage exceeded the safety limit");
  }
}

/** Blocks native work until shipped configured-MCP authority has rotated. */
export async function assertCodexBindingMayExecuteNativeWork(params: {
  bindingStore: CodexAppServerBindingStore;
  binding: CodexAppServerThreadBinding;
  readThread: (threadId: string) => Promise<CodexThread>;
  initialThread?: CodexThread;
}): Promise<void> {
  if (hasLegacyCodexNativeMcpBinding(params.binding)) {
    throw new Error(
      "This Codex thread must complete its configured MCP upgrade in a normal Codex turn before it can execute native work.",
    );
  }
  await assertNoRetiredLegacyMcpThreadLineage({
    bindingStore: params.bindingStore,
    threadId: params.binding.threadId,
    readThread: params.readThread,
    ...(params.initialThread ? { initialThread: params.initialThread } : {}),
  });
}
