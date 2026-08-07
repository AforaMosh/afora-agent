import { describe, expect, it } from "vitest";
import { createCodexTestBindingStore } from "./app-server/session-binding.test-helpers.js";
import { createCodexSupervisionTools } from "./supervision-tools.js";

type CodexSupervisionToolsOptions = Parameters<typeof createCodexSupervisionTools>[0];
type EndpointRequest = NonNullable<CodexSupervisionToolsOptions["request"]>;
type EndpointRequestHandler = (...args: Parameters<EndpointRequest>) => unknown;

function createEndpointRequest(handler: EndpointRequestHandler): EndpointRequest {
  return async <T>(...args: Parameters<EndpointRequest>) => (await handler(...args)) as T;
}

function toolByName(tools: ReturnType<typeof createCodexSupervisionTools>, name: string) {
  const tool = tools.find((entry) => entry.name === name);
  if (!tool) {
    throw new Error(`missing tool: ${name}`);
  }
  return tool;
}

async function createRetiredMcpBindingStore(threadId: string) {
  const identity = { kind: "conversation" as const, bindingId: `retired:${threadId}` };
  const store = createCodexTestBindingStore([
    {
      identity,
      binding: {
        threadId: `successor:${threadId}`,
        cwd: "/test",
        legacyMcpRetirementThreadId: threadId,
      },
    },
  ]);
  await store.recordLegacyMcpThreadRetirement(threadId);
  await store.mutate(identity, {
    kind: "complete-legacy-mcp-retirement",
    expectedThreadId: `successor:${threadId}`,
    expectedRetirementThreadId: threadId,
  });
  return store;
}

describe("Codex supervision legacy MCP controls", () => {
  it.each([
    { name: "retired root", parentThreadId: undefined },
    { name: "retired descendant", parentThreadId: "thread-retired-root" },
  ])("blocks steering a $name while keeping interrupt available", async ({ parentThreadId }) => {
    const threadId = parentThreadId ? "thread-child" : "thread-retired-root";
    const bindingStore = await createRetiredMcpBindingStore("thread-retired-root");
    const calls: string[] = [];
    const request = createEndpointRequest(async (_endpoint, method) => {
      calls.push(method);
      if (method === "thread/read") {
        return {
          thread: {
            id: threadId,
            ...(parentThreadId ? { parentThreadId } : {}),
            status: { type: "active" },
            turns: [{ id: "turn-1", status: "inProgress" }],
          },
        };
      }
      return {};
    });
    const tools = createCodexSupervisionTools({
      bindingStore,
      getPluginConfig: () => ({
        supervision: {
          enabled: true,
          allowRawTranscripts: true,
          allowWriteControls: true,
        },
      }),
      senderIsOwner: true,
      request,
    });

    await expect(
      toolByName(tools, "codex_session_send").execute("steer", {
        endpoint_id: "local",
        thread_id: threadId,
        text: "do not execute",
      }),
    ).rejects.toThrow(/configured MCP authority|retired configured MCP/u);
    await expect(
      toolByName(tools, "codex_session_interrupt").execute("interrupt", {
        endpoint_id: "local",
        thread_id: threadId,
      }),
    ).resolves.toBeDefined();
    expect(calls).toEqual(["thread/read", "thread/read", "turn/interrupt"]);
  });
});
