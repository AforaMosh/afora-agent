import { expect, it, vi } from "vitest";
import type { CodexThread } from "./protocol.js";
import type { CodexAppServerBindingStore } from "./session-binding.js";
import {
  assertCodexThreadReadResult,
  assertNoRetiredLegacyMcpThreadLineage,
} from "./thread-legacy-lineage.js";

function bindingStore(legacyThreadIds: readonly string[]): CodexAppServerBindingStore {
  return {
    hasLegacyMcpRetirementState: vi.fn(async () => legacyThreadIds.length > 0),
    inspectThreadOwnership: vi.fn(async (threadId: string) => ({
      hasUnexpectedOwner: legacyThreadIds.includes(threadId),
      hasLegacyNativeMcpOwner: legacyThreadIds.includes(threadId),
    })),
  } as unknown as CodexAppServerBindingStore;
}

function thread(id: string, parentThreadId?: string, source?: CodexThread["source"]): CodexThread {
  return { id, ...(parentThreadId ? { parentThreadId } : {}), ...(source ? { source } : {}) };
}

it.each([undefined, {}, { thread: null }, { thread: {} }, { thread: { id: "" } }])(
  "rejects an invalid thread/read lineage response %#",
  (value) => {
    expect(() => assertCodexThreadReadResult(value)).toThrow("invalid thread/read response");
  },
);

it("returns a validated thread/read lineage thread", () => {
  expect(assertCodexThreadReadResult({ thread: { id: "thread-valid" } })).toEqual({
    id: "thread-valid",
  });
});

it("skips lineage RPCs when no configured MCP retirement state exists", async () => {
  const readThread = vi.fn();
  await expect(
    assertNoRetiredLegacyMcpThreadLineage({
      bindingStore: bindingStore([]),
      threadId: "thread-current",
      readThread,
    }),
  ).resolves.toBeUndefined();
  expect(readThread).not.toHaveBeenCalled();
});

it("rejects a grandchild whose immutable parent chain reaches retired authority", async () => {
  const threads = new Map([
    ["thread-grandchild", thread("thread-grandchild", "thread-child")],
    ["thread-child", thread("thread-child", "thread-retired")],
  ]);
  const readThread = vi.fn(async (threadId: string) => {
    const value = threads.get(threadId);
    if (!value) {
      throw new Error(`unexpected read: ${threadId}`);
    }
    return value;
  });

  await expect(
    assertNoRetiredLegacyMcpThreadLineage({
      bindingStore: bindingStore(["thread-retired"]),
      threadId: "thread-grandchild",
      readThread,
    }),
  ).rejects.toThrow("descends from retired configured MCP authority");
  expect(readThread.mock.calls.map(([threadId]) => threadId)).toEqual([
    "thread-grandchild",
    "thread-child",
  ]);
});

it("uses dependency-backed parentThreadId for review subagents", async () => {
  const readThread = vi.fn(async () =>
    thread("thread-review", "thread-retired", { subAgent: "review" }),
  );

  await expect(
    assertNoRetiredLegacyMcpThreadLineage({
      bindingStore: bindingStore(["thread-retired"]),
      threadId: "thread-review",
      readThread,
    }),
  ).rejects.toThrow("descends from retired configured MCP authority");
});

it("fails closed for an older subagent row with no recoverable parent", async () => {
  await expect(
    assertNoRetiredLegacyMcpThreadLineage({
      bindingStore: bindingStore(["thread-retired"]),
      threadId: "thread-review",
      readThread: async () => thread("thread-review", undefined, { subAgent: "review" }),
    }),
  ).rejects.toThrow("unverifiable subagent ancestry");
});

it("fails closed when direct and source parent provenance disagree", async () => {
  await expect(
    assertNoRetiredLegacyMcpThreadLineage({
      bindingStore: bindingStore(["thread-retired"]),
      threadId: "thread-child",
      readThread: async () =>
        thread("thread-child", "thread-parent-a", {
          subAgent: { thread_spawn: { parent_thread_id: "thread-parent-b" } },
        }),
    }),
  ).rejects.toThrow("conflicting configured MCP parent lineage");
});
