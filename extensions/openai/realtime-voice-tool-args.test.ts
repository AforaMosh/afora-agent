import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { buildOpenAIRealtimeVoiceProvider } from "./realtime-voice-provider.js";

type RealtimeBridgeFixture = {
  serverSocket: WebSocket;
  onToolCall: ReturnType<typeof vi.fn>;
  onError: ReturnType<typeof vi.fn>;
  onEvent: ReturnType<typeof vi.fn>;
};

async function withRealtimeBridge(
  run: (fixture: RealtimeBridgeFixture) => Promise<void>,
  options?: { closeOnError?: boolean },
): Promise<void> {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected an available local realtime WebSocket address");
  }

  let serverSocket: WebSocket | undefined;
  server.once("connection", (socket) => {
    serverSocket = socket;
    socket.once("message", () => {
      socket.send(JSON.stringify({ type: "session.updated" }));
    });
  });

  const onToolCall = vi.fn();
  const onError = vi.fn((_error: Error) => {
    if (options?.closeOnError) {
      bridge.close();
    }
  });
  const onEvent = vi.fn();
  const bridge = buildOpenAIRealtimeVoiceProvider().createBridge({
    providerConfig: {
      apiKey: "fixture-local", // pragma: allowlist secret
      azureEndpoint: `http://127.0.0.1:${address.port}`,
      azureDeployment: "fixture-realtime",
    },
    onAudio: vi.fn(),
    onClearAudio: vi.fn(),
    onToolCall,
    onError,
    onEvent,
  });

  try {
    await bridge.connect();
    if (!serverSocket) {
      throw new Error("expected the provider to connect to its local realtime WebSocket");
    }
    await run({ serverSocket, onToolCall, onError, onEvent });
  } finally {
    bridge.close();
    for (const client of server.clients) {
      client.terminate();
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

async function sendToolArguments(
  socket: WebSocket,
  argumentsJson: string,
  type:
    | "response.function_call_arguments.done"
    | "conversation.item.done" = "response.function_call_arguments.done",
  options?: {
    itemId?: string;
    callId?: string;
    itemStatus?: "completed" | "incomplete" | "in_progress";
  },
): Promise<void> {
  const itemId = options?.itemId ?? "item-consult";
  const callId = options?.callId ?? "call-consult";
  const event =
    type === "conversation.item.done"
      ? {
          type,
          item: {
            id: itemId,
            type: "function_call",
            call_id: callId,
            name: "openclaw_agent_consult",
            arguments: argumentsJson,
            ...(options?.itemStatus ? { status: options.itemStatus } : {}),
          },
        }
      : {
          type,
          item_id: itemId,
          call_id: callId,
          name: "openclaw_agent_consult",
          arguments: argumentsJson,
        };
  await new Promise<void>((resolve, reject) => {
    socket.send(JSON.stringify(event), (error) => (error ? reject(error) : resolve()));
  });
}

async function sendResponseTerminal(
  socket: WebSocket,
  status: "completed" | "cancelled" | "failed" | "incomplete",
  type: "response.done" | "response.cancelled" = "response.done",
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    socket.send(JSON.stringify({ type, response: { id: "response-consult", status } }), (error) =>
      error ? reject(error) : resolve(),
    );
  });
}

async function waitForServerEvent(
  onEvent: ReturnType<typeof vi.fn>,
  type: string,
  minimumCount = 1,
): Promise<void> {
  await vi.waitFor(() => {
    const matches = onEvent.mock.calls.filter(([event]) => {
      const fields = event as { direction?: string; type?: string };
      return fields.direction === "server" && fields.type === type;
    });
    expect(matches.length).toBeGreaterThanOrEqual(minimumCount);
  });
}

describe("OpenAI realtime tool argument ownership", () => {
  it.each([
    { name: "truncated JSON", argumentsJson: '{"question":', diagnosis: "invalid JSON" },
    { name: "malformed JSON", argumentsJson: '{"question":}', diagnosis: "invalid JSON" },
    { name: "a JSON array", argumentsJson: '["unsafe"]', diagnosis: "must be a JSON object" },
    { name: "JSON null", argumentsJson: "null", diagnosis: "must be a JSON object" },
    { name: "a JSON number", argumentsJson: "42", diagnosis: "must be a JSON object" },
    { name: "a JSON boolean", argumentsJson: "true", diagnosis: "must be a JSON object" },
  ])(
    "reports authoritative $name without dispatching a tool",
    async ({ argumentsJson, diagnosis }) => {
      await withRealtimeBridge(async ({ serverSocket, onToolCall, onError }) => {
        await sendToolArguments(serverSocket, argumentsJson, "conversation.item.done");
        await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());

        expect(onToolCall).not.toHaveBeenCalled();
        expect(onError).toHaveBeenCalledWith(
          expect.objectContaining({
            message: expect.stringContaining(diagnosis),
          }),
        );
      });
    },
  );

  it.each([
    { name: "truncated JSON", argumentsJson: '{"question":', diagnosis: "invalid JSON" },
    { name: "malformed JSON", argumentsJson: '{"question":}', diagnosis: "invalid JSON" },
    { name: "a JSON array", argumentsJson: '["unsafe"]', diagnosis: "must be a JSON object" },
    { name: "JSON null", argumentsJson: "null", diagnosis: "must be a JSON object" },
    { name: "a JSON number", argumentsJson: "42", diagnosis: "must be a JSON object" },
    { name: "a JSON boolean", argumentsJson: "true", diagnosis: "must be a JSON object" },
  ])(
    "defers provisional $name until its authoritative item",
    async ({ argumentsJson, diagnosis }) => {
      await withRealtimeBridge(async ({ serverSocket, onToolCall, onError, onEvent }) => {
        await sendToolArguments(serverSocket, argumentsJson);
        await waitForServerEvent(onEvent, "response.function_call_arguments.done");

        expect(onToolCall).not.toHaveBeenCalled();
        expect(onError).not.toHaveBeenCalled();

        await sendToolArguments(serverSocket, argumentsJson, "conversation.item.done");
        await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());

        expect(onToolCall).not.toHaveBeenCalled();
        expect(onError).toHaveBeenCalledWith(
          expect.objectContaining({
            message: expect.stringContaining(diagnosis),
          }),
        );
      });
    },
  );

  it.each([
    { name: "the shipped empty argument contract", argumentsJson: "", expectedArguments: {} },
    {
      name: "a valid argument object",
      argumentsJson: '{"question":"valid request"}',
      expectedArguments: { question: "valid request" },
    },
  ])("preserves $name", async ({ argumentsJson, expectedArguments }) => {
    await withRealtimeBridge(async ({ serverSocket, onToolCall, onError }) => {
      await sendToolArguments(serverSocket, argumentsJson);
      await vi.waitFor(() => expect(onToolCall).toHaveBeenCalledOnce());

      expect(onToolCall).toHaveBeenCalledWith({
        itemId: "item-consult",
        callId: "call-consult",
        name: "openclaw_agent_consult",
        args: expectedArguments,
      });
      expect(onError).not.toHaveBeenCalled();
    });
  });

  it("recovers the authoritative item with a consumer that closes its bridge on errors", async () => {
    await withRealtimeBridge(
      async ({ serverSocket, onToolCall, onError, onEvent }) => {
        await sendToolArguments(serverSocket, '{"question":');
        await waitForServerEvent(onEvent, "response.function_call_arguments.done");

        expect(onError).not.toHaveBeenCalled();
        expect(onToolCall).not.toHaveBeenCalled();

        await sendToolArguments(
          serverSocket,
          '{"question":"authoritative recovery"}',
          "conversation.item.done",
        );
        await vi.waitFor(() => {
          expect(onToolCall).toHaveBeenCalledWith({
            itemId: "item-consult",
            callId: "call-consult",
            name: "openclaw_agent_consult",
            args: { question: "authoritative recovery" },
          });
        });

        expect(onToolCall).toHaveBeenCalledOnce();
        expect(onError).not.toHaveBeenCalled();
      },
      { closeOnError: true },
    );
  });

  it.each(["incomplete", "in_progress"] as const)(
    "keeps a closing consumer alive while an authoritative item remains %s",
    async (itemStatus) => {
      await withRealtimeBridge(
        async ({ serverSocket, onToolCall, onError, onEvent }) => {
          await sendToolArguments(serverSocket, '{"question":');
          await waitForServerEvent(onEvent, "response.function_call_arguments.done");
          await sendToolArguments(serverSocket, '{"question":', "conversation.item.done", {
            itemStatus,
          });
          await waitForServerEvent(onEvent, "conversation.item.done");

          expect(onError).not.toHaveBeenCalled();
          expect(onToolCall).not.toHaveBeenCalled();

          await sendResponseTerminal(serverSocket, "cancelled");
          await waitForServerEvent(onEvent, "response.done");

          expect(onError).not.toHaveBeenCalled();
          expect(onToolCall).not.toHaveBeenCalled();
        },
        { closeOnError: true },
      );
    },
  );

  it.each(["incomplete", "in_progress"] as const)(
    "does not execute valid arguments from an unfinished %s item",
    async (itemStatus) => {
      await withRealtimeBridge(
        async ({ serverSocket, onToolCall, onError, onEvent }) => {
          await sendToolArguments(
            serverSocket,
            '{"question":"unfinished but syntactically valid"}',
            "conversation.item.done",
            { itemStatus },
          );
          await waitForServerEvent(onEvent, "conversation.item.done");

          expect(onToolCall).not.toHaveBeenCalled();
          expect(onError).not.toHaveBeenCalled();

          await sendResponseTerminal(serverSocket, "cancelled");
          await waitForServerEvent(onEvent, "response.done");

          expect(onToolCall).not.toHaveBeenCalled();
          expect(onError).not.toHaveBeenCalled();
        },
        { closeOnError: true },
      );
    },
  );

  it("executes a corrected completed item after ignoring its valid unfinished predecessor", async () => {
    await withRealtimeBridge(async ({ serverSocket, onToolCall, onError, onEvent }) => {
      await sendToolArguments(serverSocket, '{"question":"unfinished"}', "conversation.item.done", {
        itemStatus: "incomplete",
      });
      await waitForServerEvent(onEvent, "conversation.item.done");

      expect(onToolCall).not.toHaveBeenCalled();

      await sendToolArguments(serverSocket, '{"question":"completed"}', "conversation.item.done", {
        itemStatus: "completed",
      });
      await vi.waitFor(() => expect(onToolCall).toHaveBeenCalledOnce());

      expect(onToolCall).toHaveBeenCalledWith(
        expect.objectContaining({ args: { question: "completed" } }),
      );
      expect(onError).not.toHaveBeenCalled();
    });
  });

  it("tracks parallel invalid identities independently through correction", async () => {
    await withRealtimeBridge(async ({ serverSocket, onToolCall, onError, onEvent }) => {
      await sendToolArguments(serverSocket, '{"first":', "response.function_call_arguments.done", {
        itemId: "item-first",
        callId: "call-first",
      });
      await sendToolArguments(serverSocket, '{"second":', "response.function_call_arguments.done", {
        itemId: "item-second",
        callId: "call-second",
      });
      await waitForServerEvent(onEvent, "response.function_call_arguments.done", 2);

      expect(onError).not.toHaveBeenCalled();

      await sendToolArguments(serverSocket, '{"second":"recovered"}', "conversation.item.done", {
        itemId: "item-second",
        callId: "call-second",
      });
      await vi.waitFor(() => expect(onToolCall).toHaveBeenCalledOnce());
      expect(onToolCall).toHaveBeenCalledWith(
        expect.objectContaining({
          itemId: "item-second",
          callId: "call-second",
          args: { second: "recovered" },
        }),
      );

      await sendToolArguments(serverSocket, '{"first":', "conversation.item.done", {
        itemId: "item-first",
        callId: "call-first",
      });
      await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());

      expect(onToolCall).toHaveBeenCalledOnce();
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining("invalid JSON") }),
      );
    });
  });

  it("does not spend pending-identity capacity on repeated provisional frames", async () => {
    await withRealtimeBridge(async ({ serverSocket, onToolCall, onError, onEvent }) => {
      for (let index = 0; index < 20; index += 1) {
        await sendToolArguments(serverSocket, '{"question":');
      }
      await waitForServerEvent(onEvent, "response.function_call_arguments.done", 20);

      expect(onError).not.toHaveBeenCalled();
      expect(onToolCall).not.toHaveBeenCalled();

      await sendToolArguments(serverSocket, '{"question":"recovered"}', "conversation.item.done");
      await vi.waitFor(() => expect(onToolCall).toHaveBeenCalledOnce());

      expect(onToolCall).toHaveBeenCalledWith(
        expect.objectContaining({ args: { question: "recovered" } }),
      );
      expect(onError).not.toHaveBeenCalled();
    });
  });

  it("hard-caps hostile pending identities and reports exactly one overflow", async () => {
    await withRealtimeBridge(async ({ serverSocket, onToolCall, onError, onEvent }) => {
      for (let index = 0; index < 33; index += 1) {
        await sendToolArguments(
          serverSocket,
          '{"question":',
          "response.function_call_arguments.done",
          {
            itemId: `item-hostile-${index}`,
            callId: `call-hostile-${index}`,
          },
        );
      }
      await waitForServerEvent(onEvent, "response.function_call_arguments.done", 33);

      expect(onToolCall).not.toHaveBeenCalled();
      expect(onError).toHaveBeenCalledOnce();
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining("pending argument limit exceeded (16)"),
        }),
      );

      await sendResponseTerminal(serverSocket, "cancelled");
      await waitForServerEvent(onEvent, "response.done");
      await sendToolArguments(serverSocket, '{"question":"fresh response"}');
      await vi.waitFor(() => expect(onToolCall).toHaveBeenCalledOnce());

      expect(onToolCall).toHaveBeenCalledWith(
        expect.objectContaining({ args: { question: "fresh response" } }),
      );
      expect(onError).toHaveBeenCalledOnce();
    });
  });

  it("reports unresolved malformed arguments when the response completes", async () => {
    await withRealtimeBridge(async ({ serverSocket, onToolCall, onError, onEvent }) => {
      await sendToolArguments(serverSocket, '{"question":');
      await waitForServerEvent(onEvent, "response.function_call_arguments.done");

      expect(onError).not.toHaveBeenCalled();

      await sendResponseTerminal(serverSocket, "completed");
      await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());

      expect(onToolCall).not.toHaveBeenCalled();
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining("invalid JSON") }),
      );
    });
  });

  it.each([
    { name: "a cancelled response", status: "cancelled" as const, type: "response.done" as const },
    {
      name: "an explicit response cancellation",
      status: "cancelled" as const,
      type: "response.cancelled" as const,
    },
    { name: "a failed response", status: "failed" as const, type: "response.done" as const },
    {
      name: "an incomplete response",
      status: "incomplete" as const,
      type: "response.done" as const,
    },
  ])("drops provisional invalid arguments for $name", async ({ status, type }) => {
    await withRealtimeBridge(async ({ serverSocket, onToolCall, onError, onEvent }) => {
      await sendToolArguments(serverSocket, '{"question":');
      await waitForServerEvent(onEvent, "response.function_call_arguments.done");
      await sendResponseTerminal(serverSocket, status, type);
      await waitForServerEvent(onEvent, type);

      expect(onToolCall).not.toHaveBeenCalled();
      expect(
        onError.mock.calls.filter(([error]) =>
          (error as Error).message.includes("invalid JSON arguments"),
        ),
      ).toHaveLength(0);

      const previousErrorCount = onError.mock.calls.length;
      await sendResponseTerminal(serverSocket, "completed");
      await waitForServerEvent(onEvent, "response.done", type === "response.done" ? 2 : 1);
      expect(onError).toHaveBeenCalledTimes(previousErrorCount);
    });
  });
});
