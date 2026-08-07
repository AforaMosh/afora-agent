import { describe, expect, it } from "vitest";
import { createCodexTestBindingStore } from "./app-server/session-binding.test-helpers.js";
import { createCodexSupervisionTools } from "./supervision-tools.js";

type CodexSupervisionToolsOptions = Parameters<typeof createCodexSupervisionTools>[0];
type EndpointRequest = NonNullable<CodexSupervisionToolsOptions["request"]>;
type EndpointRequestHandler = (...args: Parameters<EndpointRequest>) => unknown;
type RecordedRequest = { method: string; params?: unknown };

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

function createRequest(thread: Record<string, unknown>) {
  const calls: RecordedRequest[] = [];
  const request = createEndpointRequest(async (_endpoint, method, params) => {
    calls.push({ method, ...(params === undefined ? {} : { params }) });
    if (method === "thread/read") {
      return { thread };
    }
    return {};
  });
  return { calls, request };
}

function createTools(request: EndpointRequest) {
  return createCodexSupervisionTools({
    bindingStore: createCodexTestBindingStore(),
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
}

describe("Codex supervision write controls", () => {
  it("rechecks write policy before mutating an active turn", async () => {
    let pluginConfig: unknown = {
      supervision: { enabled: true, allowWriteControls: true },
    };
    const methods: string[] = [];
    const request = createEndpointRequest(async (_endpoint, method) => {
      methods.push(method);
      if (method !== "thread/read") {
        throw new Error(`unexpected method: ${method}`);
      }
      pluginConfig = { supervision: { enabled: true, allowWriteControls: false } };
      return {
        thread: {
          id: "thread-1",
          status: { type: "active" },
          turns: [{ id: "turn-1", status: "inProgress" }],
        },
      };
    });
    const tools = createCodexSupervisionTools({
      bindingStore: createCodexTestBindingStore(),
      getPluginConfig: () => pluginConfig,
      senderIsOwner: true,
      request,
    });

    await expect(
      toolByName(tools, "codex_session_send").execute("send", {
        endpoint_id: "local",
        thread_id: "thread-1",
        text: "continue",
      }),
    ).rejects.toThrow("Codex write controls are disabled");
    expect(methods).toEqual(["thread/read"]);
  });

  it("rejects an endpoint repoint before mutating an active turn", async () => {
    let pluginConfig: unknown = {
      supervision: {
        enabled: true,
        allowWriteControls: true,
        endpoints: [{ id: "primary", transport: "stdio-proxy", command: "codex-a" }],
      },
    };
    const methods: string[] = [];
    const request = createEndpointRequest(async (_endpoint, method) => {
      methods.push(method);
      if (method !== "thread/read") {
        throw new Error(`unexpected method: ${method}`);
      }
      pluginConfig = {
        supervision: {
          enabled: true,
          allowWriteControls: true,
          endpoints: [{ id: "primary", transport: "stdio-proxy", command: "codex-b" }],
        },
      };
      return {
        thread: {
          id: "thread-1",
          status: { type: "active" },
          turns: [{ id: "turn-1", status: "inProgress" }],
        },
      };
    });
    const tools = createCodexSupervisionTools({
      bindingStore: createCodexTestBindingStore(),
      getPluginConfig: () => pluginConfig,
      senderIsOwner: true,
      request,
    });

    await expect(
      toolByName(tools, "codex_session_send").execute("send", {
        endpoint_id: "primary",
        thread_id: "thread-1",
        text: "continue",
      }),
    ).rejects.toThrow("endpoint primary was removed or changed");
    expect(methods).toEqual(["thread/read"]);
  });

  it("rejects explicit starts and idle auto sends without a mutating request", async () => {
    const { calls, request } = createRequest({
      id: "thread-1",
      status: { type: "idle" },
      turns: [],
    });
    const tools = createTools(request);
    const send = toolByName(tools, "codex_session_send");

    await expect(
      send.execute("start", {
        endpoint_id: "local",
        thread_id: "thread-1",
        text: "continue",
        mode: "start",
      }),
    ).rejects.toThrow("Continue it from Codex Sessions");
    expect(calls).toEqual([]);

    await expect(
      send.execute("auto", {
        endpoint_id: "local",
        thread_id: "thread-1",
        text: "continue",
      }),
    ).rejects.toThrow("Continue it from Codex Sessions");
    expect(calls.map((call) => call.method)).toEqual(["thread/read"]);
  });

  it("steers and interrupts only after a passive active-turn read", async () => {
    const { calls, request } = createRequest({
      id: "thread-1",
      status: { type: "active" },
      turns: [{ id: "turn-1", status: "inProgress" }],
    });
    const tools = createTools(request);

    await toolByName(tools, "codex_session_send").execute("steer", {
      endpoint_id: "local",
      thread_id: "thread-1",
      text: "focus on the failing test",
      mode: "steer",
    });
    await toolByName(tools, "codex_session_interrupt").execute("interrupt", {
      endpoint_id: "local",
      thread_id: "thread-1",
    });

    expect(calls).toEqual([
      {
        method: "thread/read",
        params: { threadId: "thread-1", includeTurns: true },
      },
      {
        method: "turn/steer",
        params: {
          threadId: "thread-1",
          expectedTurnId: "turn-1",
          input: [
            {
              type: "text",
              text: "focus on the failing test",
              text_elements: [],
            },
          ],
        },
      },
      {
        method: "thread/read",
        params: { threadId: "thread-1", includeTurns: true },
      },
      {
        method: "turn/interrupt",
        params: { threadId: "thread-1", turnId: "turn-1" },
      },
    ]);
    expect(calls.some((call) => call.method === "turn/start")).toBe(false);
    expect(calls.some((call) => call.method === "thread/resume")).toBe(false);
  });
});
