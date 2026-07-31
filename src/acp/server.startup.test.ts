/** Tests process-local ACP stdio composition and shutdown ownership. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => {
  let resolveClosed: (() => void) | undefined;
  let closeController: AbortController | undefined;
  let transportController: ReadableStreamDefaultController<unknown> | undefined;
  return {
    agentSideConnectionCtor: vi.fn(),
    closeConnection: () => {
      transportController?.close();
    },
    failConnection: (error: unknown) => {
      transportController?.error(error);
    },
    finishConnection: (error?: unknown) => {
      if (error !== undefined) {
        closeController?.abort(error);
      }
      resolveClosed?.();
    },
    createTransportReadable: () =>
      new ReadableStream({
        start(controller) {
          transportController = controller;
        },
      }),
    resetConnection: () => {
      closeController = new AbortController();
      const closed = new Promise<void>((resolve) => {
        resolveClosed = resolve;
      });
      return { closed, signal: closeController.signal };
    },
    routeLogsToStderr: vi.fn(),
    closeStateDatabase: vi.fn(),
  };
});

vi.mock("@agentclientprotocol/sdk", () => ({
  AGENT_METHODS: {
    initialize: "initialize",
  },
  AgentSideConnection: function AgentSideConnection(
    factory: (connection: unknown) => unknown,
    stream: unknown,
  ) {
    mockState.agentSideConnectionCtor(factory, stream);
    factory({});
    const lifecycle = mockState.resetConnection();
    void (stream as { readable: ReadableStream }).readable.pipeTo(new WritableStream()).then(
      () => mockState.finishConnection(),
      (error: unknown) => mockState.finishConnection(error),
    );
    return lifecycle;
  },
  PROTOCOL_VERSION: 1,
  ndJsonStream: vi.fn(() => ({
    writable: new WritableStream(),
    readable: mockState.createTransportReadable(),
  })),
}));

vi.mock("../infra/is-main.js", () => ({
  isMainModule: () => false,
}));

vi.mock("../logging/console.js", () => ({
  routeLogsToStderr: () => mockState.routeLogsToStderr(),
}));

vi.mock("../state/openclaw-state-db.js", () => ({
  closeOpenClawStateDatabase: () => mockState.closeStateDatabase(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("serveAcp", () => {
  beforeEach(() => {
    mockState.agentSideConnectionCtor.mockClear();
    mockState.closeStateDatabase.mockClear();
    mockState.routeLogsToStderr.mockClear();
  });

  it("constructs the local agent immediately without an external runtime", async () => {
    const { serveAcp } = await import("./server.js");
    const shutdown = vi.fn(async () => {});
    const serve = serveAcp(
      {},
      {
        input: new ReadableStream(),
        output: new WritableStream(),
        createAgent: () => ({ shutdown }) as never,
        installSignalHandlers: false,
      },
    );

    expect(mockState.agentSideConnectionCtor).toHaveBeenCalledTimes(1);
    expect(shutdown).not.toHaveBeenCalled();

    mockState.closeConnection();
    await serve;

    expect(shutdown).toHaveBeenCalledWith(undefined);
  });

  it("leaves process-global state ownership with an embedding host", async () => {
    const { serveAcp } = await import("./server.js");
    const serve = serveAcp(
      {},
      {
        input: new ReadableStream(),
        output: new WritableStream(),
        createAgent: () => ({ shutdown: vi.fn(async () => {}) }) as never,
        installSignalHandlers: false,
      },
    );

    mockState.closeConnection();
    await serve;

    expect(mockState.closeStateDatabase).not.toHaveBeenCalled();
  });

  it("waits for agent shutdown before closing owned state", async () => {
    const { serveAcp } = await import("./server.js");
    const release = deferred<void>();
    const shutdown = vi.fn(async () => {
      await release.promise;
    });
    const closeStateDatabase = vi.fn();
    const serve = serveAcp(
      {},
      {
        input: new ReadableStream(),
        output: new WritableStream(),
        createAgent: () => ({ shutdown }) as never,
        closeStateDatabase,
        installSignalHandlers: false,
      },
    );

    mockState.closeConnection();
    await vi.waitFor(() => expect(shutdown).toHaveBeenCalledTimes(1));
    expect(closeStateDatabase).not.toHaveBeenCalled();

    release.resolve();
    await serve;
    expect(closeStateDatabase).toHaveBeenCalledTimes(1);
  });

  it("passes transport failures through shutdown and the serve result", async () => {
    const { serveAcp } = await import("./server.js");
    const shutdown = vi.fn(async () => {});
    const serve = serveAcp(
      {},
      {
        input: new ReadableStream(),
        output: new WritableStream(),
        createAgent: () => ({ shutdown }) as never,
        closeStateDatabase: vi.fn(),
        installSignalHandlers: false,
      },
    );
    const error = new Error("stdio closed unexpectedly");

    mockState.failConnection(error);
    await expect(serve).rejects.toBe(error);
    expect(shutdown).toHaveBeenCalledWith(error);
  });

  it("propagates shutdown failures after closing owned state", async () => {
    const { serveAcp } = await import("./server.js");
    const error = new Error("local shutdown failed");
    const closeStateDatabase = vi.fn();
    const serve = serveAcp(
      {},
      {
        input: new ReadableStream(),
        output: new WritableStream(),
        createAgent: () =>
          ({
            shutdown: vi.fn(async () => {
              throw error;
            }),
          }) as never,
        closeStateDatabase,
        installSignalHandlers: false,
      },
    );

    mockState.closeConnection();
    await expect(serve).rejects.toBe(error);
    expect(closeStateDatabase).toHaveBeenCalledTimes(1);
  });
});
