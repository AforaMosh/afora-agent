import { formatErrorMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { CodexAppServerClient } from "./client.js";
import type { CodexThread } from "./protocol.js";
import type {
  CodexAppServerBindingIdentity,
  CodexAppServerBindingStore,
} from "./session-binding.js";
import { assertCodexArchiveDescendantsUnowned } from "./thread-archive-guard.js";
import { CodexThreadBindingConflictError } from "./thread-lifecycle-errors.js";
import { retireCodexSupervisionArtifact } from "./thread-supervision.js";

class CodexLegacyMcpRetirementRecordError extends Error {
  constructor(threadId: string, options?: ErrorOptions) {
    super(`Codex legacy MCP retirement could not be recorded: ${threadId}`, options);
    this.name = "CodexLegacyMcpRetirementRecordError";
  }
}

/** Retires one shipped native-MCP predecessor without disrupting another owner or active subtree. */
export async function retireLegacyMcpPredecessor(params: {
  client: CodexAppServerClient;
  bindingStore: CodexAppServerBindingStore;
  bindingIdentity: CodexAppServerBindingIdentity;
  threadId: string;
  retirementMode: "archive" | "preserve";
  signal?: AbortSignal;
}): Promise<void> {
  const ownership = await params.bindingStore.inspectThreadOwnership(
    params.threadId,
    [params.bindingIdentity],
    true,
  );
  if (ownership.hasUnexpectedOwner) {
    if (ownership.hasLegacyMigrationAlias) {
      throw new Error(
        "Codex configured MCP ownership still has a shipped compatibility alias; run `openclaw doctor --fix`, then retry the normal Codex turn",
      );
    }
    throw new CodexThreadBindingConflictError(
      params.threadId,
      "retiring a legacy MCP thread owned by another session",
    );
  }
  if (params.retirementMode === "archive") {
    let response: { thread: CodexThread } | undefined;
    try {
      response = await params.client.request(
        "thread/read",
        { threadId: params.threadId, includeTurns: false },
        { signal: params.signal },
      );
    } catch (error) {
      if (!isTerminalLegacyMcpPredecessorReadError(error, params.threadId)) {
        throw error;
      }
    }
    if (response) {
      if (response.thread.id !== params.threadId) {
        throw new Error("Codex returned a different legacy MCP predecessor during retirement");
      }
      const status = response.thread.status?.type;
      if (status !== "idle" && status !== "notLoaded") {
        throw new Error(
          status === "active"
            ? "Codex legacy MCP predecessor is active; wait for its turn to finish"
            : "Codex legacy MCP predecessor is unavailable for safe retirement",
        );
      }
      await assertCodexArchiveDescendantsUnowned({
        bindingStore: params.bindingStore,
        threadId: params.threadId,
        listPage: async (request) =>
          await params.client.request("thread/list", request, { signal: params.signal }),
        rejectAnyDescendant: true,
        assertDescendantIdle: async (threadId) => {
          const descendant = await params.client.request(
            "thread/read",
            { threadId, includeTurns: false },
            { signal: params.signal },
          );
          const descendantStatus = descendant.thread.status?.type;
          if (
            descendant.thread.id !== threadId ||
            (descendantStatus !== "idle" && descendantStatus !== "notLoaded")
          ) {
            throw new Error(`Codex legacy MCP descendant is not safely idle: ${threadId}`);
          }
        },
      });
    }
    if (response && !(await retireCodexSupervisionArtifact(params.client, params.threadId))) {
      throw new Error(`Codex legacy MCP predecessor could not be archived: ${params.threadId}`);
    }
  }
  try {
    if (!(await params.bindingStore.recordLegacyMcpThreadRetirement(params.threadId))) {
      throw new CodexLegacyMcpRetirementRecordError(params.threadId);
    }
  } catch (error) {
    if (error instanceof CodexLegacyMcpRetirementRecordError) {
      throw error;
    }
    throw new CodexLegacyMcpRetirementRecordError(params.threadId, { cause: error });
  }
}

function isTerminalLegacyMcpPredecessorReadError(error: unknown, threadId: string): boolean {
  const message = formatErrorMessage(error).toLowerCase();
  const normalizedThreadId = threadId.toLowerCase();
  return (
    message.includes(`thread ${normalizedThreadId} is archived`) ||
    message.includes(`thread not loaded: ${normalizedThreadId}`) ||
    message.includes(`no rollout found for thread id ${normalizedThreadId}`)
  );
}
