// Slack tests cover provider.reconnect plugin behavior.
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  gracefulStopSlackApp,
  publishSlackBlockedStatus,
  publishSlackConnectedStatus,
  publishSlackDisconnectedStatus,
  startSlackSocketAndWaitForDisconnect,
} from "./provider-support.js";
import {
  formatSlackSocketModeSharedConnectionWarning,
  formatUnknownError,
  registerSlackSocketModeConnectionDiagnostics,
  waitForSlackSocketDisconnect,
} from "./reconnect-policy.js";

function statusCallAt(setStatus: ReturnType<typeof vi.fn>, index: number): Record<string, unknown> {
  const call = setStatus.mock.calls[index];
  if (!call) {
    throw new Error(`expected status call ${index}`);
  }
  const [status] = call;
  if (!status || typeof status !== "object" || Array.isArray(status)) {
    throw new Error(`expected status call ${index} payload`);
  }
  return status as Record<string, unknown>;
}

describe("slack socket reconnect helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("marks socket mode healthy without seeding event liveness on connect", () => {
    const setStatus = vi.fn();
    vi.spyOn(Date, "now").mockReturnValue(1_711_406_400_000);

    publishSlackConnectedStatus(setStatus);

    expect(setStatus).toHaveBeenCalledTimes(1);
    const status = statusCallAt(setStatus, 0);
    expect(status?.connected).toBe(true);
    expect(status?.lastConnectedAt).toBe(1_711_406_400_000);
    expect(status?.lifecycle).toBe("ready");
    expect(status?.lastError).toBeNull();
    expect(status).not.toHaveProperty("lastEventAt");
  });

  it("marks socket mode degraded when boot identity is unavailable", () => {
    const setStatus = vi.fn();
    vi.spyOn(Date, "now").mockReturnValue(1_711_406_400_500);

    publishSlackConnectedStatus(setStatus, {
      lifecycle: "blocked",
      lastError: "auth.test returned no user_id",
    });

    expect(setStatus).toHaveBeenCalledTimes(1);
    expect(setStatus).toHaveBeenCalledWith({
      connected: true,
      lastConnectedAt: 1_711_406_400_500,
      terminalDisconnect: undefined,
      lifecycle: "blocked",
      lastError: "auth.test returned no user_id",
    });
  });

  it("marks non-recoverable socket authentication failures blocked", () => {
    const setStatus = vi.fn();

    publishSlackBlockedStatus(setStatus, new Error("invalid_auth"));

    expect(setStatus).toHaveBeenCalledWith({
      connected: false,
      lifecycle: "blocked",
      terminalDisconnect: true,
      lastError: "invalid_auth",
    });
  });

  it("marks socket mode disconnected when an error closes the socket", () => {
    const setStatus = vi.fn();
    const err = new Error("dns down");
    vi.spyOn(Date, "now").mockReturnValue(1_711_406_401_000);

    publishSlackDisconnectedStatus(setStatus, err);

    expect(setStatus).toHaveBeenCalledTimes(1);
    expect(setStatus).toHaveBeenCalledWith({
      connected: false,
      lifecycle: "recovering",
      lastDisconnect: {
        at: 1_711_406_401_000,
        error: "dns down",
      },
      lastError: "dns down",
    });
  });

  it("marks socket mode disconnected without error when the socket closes cleanly", () => {
    const setStatus = vi.fn();
    vi.spyOn(Date, "now").mockReturnValue(1_711_406_402_000);

    publishSlackDisconnectedStatus(setStatus);

    expect(setStatus).toHaveBeenCalledTimes(1);
    expect(setStatus).toHaveBeenCalledWith({
      connected: false,
      lifecycle: "recovering",
      lastDisconnect: {
        at: 1_711_406_402_000,
      },
      lastError: null,
    });
  });

  it("formats missing and unserializable socket errors without leaking undefined", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(formatUnknownError(undefined)).toBe("no error detail");
    expect(formatUnknownError(null)).toBe("no error detail");
    expect(formatUnknownError("")).toBe("no error detail");
    expect(formatUnknownError(new Error(""))).toBe("Error");
    expect(formatUnknownError(circular)).toBe('{"self":"[Circular]"}');
  });

  it("formats structured Slack socket errors", () => {
    expect(
      formatUnknownError({
        code: "slack_webapi_platform_error",
        data: {
          error: "missing_scope",
          needed: "connections:write",
          response_metadata: {
            messages: ["[ERROR] missing required scope"],
          },
        },
      }),
    ).toBe(
      "code: slack_webapi_platform_error; slack error: missing_scope; needed: connections:write; slack message: [ERROR] missing required scope",
    );
  });

  it("formats shared Socket Mode connection warnings with remediation", () => {
    expect(formatSlackSocketModeSharedConnectionWarning(2)).toContain(
      "slack socket mode reports 2 active connections for this Slack app",
    );
    expect(formatSlackSocketModeSharedConnectionWarning(2)).toContain(
      "equivalent routing and authorization",
    );
  });

  it("warns once when Slack reports a shared Socket Mode app token", () => {
    const client = new EventEmitter();
    const onSharedConnection = vi.fn();
    const diagnostics = registerSlackSocketModeConnectionDiagnostics({
      app: { receiver: { client } },
      onSharedConnection,
      onDisconnected: vi.fn(),
      onReconnected: vi.fn(),
    });

    client.emit(
      "ws_message",
      Buffer.from(JSON.stringify({ type: "events_api", payload: { text: "hello" } })),
      false,
    );
    client.emit(
      "ws_message",
      Buffer.from(JSON.stringify({ type: "hello", num_connections: "2" })),
      false,
    );
    client.emit(
      "ws_message",
      Buffer.from(JSON.stringify({ type: "hello", num_connections: 1 })),
      false,
    );
    client.emit(
      "ws_message",
      Buffer.from(JSON.stringify({ type: "hello", num_connections: 4 })),
      true,
    );
    client.emit("ws_message", JSON.stringify({ type: "hello", num_connections: 2 }), false);
    client.emit("ws_message", JSON.stringify({ type: "hello", num_connections: 3 }), false);

    expect(onSharedConnection).toHaveBeenCalledTimes(1);
    expect(onSharedConnection).toHaveBeenCalledWith(2);

    diagnostics.unregister();
    client.emit(
      "ws_message",
      Buffer.from(JSON.stringify({ type: "hello", num_connections: 2 })),
      false,
    );
    expect(onSharedConnection).toHaveBeenCalledTimes(1);
    expect(client.listenerCount("ws_message")).toBe(0);
  });

  it("tracks native socket recovery without restarting or losing the current account health", async () => {
    const client = new EventEmitter();
    const setStatus = vi.fn();
    const controller = new AbortController();
    const identityHealth = {
      lifecycle: "blocked" as const,
      lastError: "auth.test returned no user_id",
    };
    const app = {
      receiver: { client },
      start: vi.fn(async () => {
        client.emit("connected");
      }),
    };
    const diagnostics = registerSlackSocketModeConnectionDiagnostics({
      app,
      onSharedConnection: vi.fn(),
      onDisconnected: () => publishSlackDisconnectedStatus(setStatus),
      onReconnected: () => publishSlackConnectedStatus(setStatus, identityHealth),
    });
    const waiter = startSlackSocketAndWaitForDisconnect({
      app,
      abortSignal: controller.signal,
      onStarted: () => publishSlackConnectedStatus(setStatus, identityHealth),
    });

    await vi.waitFor(() => expect(setStatus).toHaveBeenCalledTimes(1));
    expect(statusCallAt(setStatus, 0)).toMatchObject({
      connected: true,
      lifecycle: "blocked",
      lastError: "auth.test returned no user_id",
    });

    client.emit("close");
    expect(statusCallAt(setStatus, 1)).toMatchObject({
      connected: false,
      lifecycle: "recovering",
      lastError: null,
    });
    client.emit("reconnecting");
    expect(setStatus).toHaveBeenCalledTimes(2);

    let hasExited = false;
    void waiter.then(() => {
      hasExited = true;
    });
    await Promise.resolve();
    expect(hasExited).toBe(false);
    expect(app.start).toHaveBeenCalledTimes(1);

    client.emit("connected");
    expect(statusCallAt(setStatus, 2)).toMatchObject({
      connected: true,
      lifecycle: "blocked",
      lastError: "auth.test returned no user_id",
    });

    expect(app.start).toHaveBeenCalledTimes(1);

    controller.abort();
    await expect(waiter).resolves.toEqual({ event: "disconnect" });
    diagnostics.unregister();
  });

  it("restores a successful outer restart when its receiver omits the connected event", async () => {
    const client = new EventEmitter();
    const setStatus = vi.fn();
    const controller = new AbortController();
    const app = {
      receiver: { client },
      start: vi.fn(async () => {}),
    };
    const diagnostics = registerSlackSocketModeConnectionDiagnostics({
      app,
      onSharedConnection: vi.fn(),
      onDisconnected: () => publishSlackDisconnectedStatus(setStatus),
      onReconnected: vi.fn(),
    });
    let currentConnection: (() => boolean) | undefined;
    const start = () =>
      startSlackSocketAndWaitForDisconnect({
        app,
        abortSignal: controller.signal,
        onStarted: () => {
          currentConnection = diagnostics.markStartedConnection();
          if (currentConnection()) {
            publishSlackConnectedStatus(setStatus);
          }
        },
      });

    try {
      const initialRun = start();
      await vi.waitFor(() => {
        expect(setStatus).toHaveBeenLastCalledWith(
          expect.objectContaining({ connected: true, lifecycle: "ready" }),
        );
      });
      const initialConnection = currentConnection;

      client.emit("close");
      expect(setStatus).toHaveBeenLastCalledWith(
        expect.objectContaining({ connected: false, lifecycle: "recovering" }),
      );
      client.emit("disconnected");
      await expect(initialRun).resolves.toEqual({ event: "disconnect" });
      expect(initialConnection?.()).toBe(false);

      const restartedRun = start();
      await vi.waitFor(() => {
        expect(setStatus).toHaveBeenLastCalledWith(
          expect.objectContaining({ connected: true, lifecycle: "ready", lastError: null }),
        );
      });
      expect(app.start).toHaveBeenCalledTimes(2);
      expect(initialConnection?.()).toBe(false);
      expect(currentConnection?.()).toBe(true);

      controller.abort();
      await expect(restartedRun).resolves.toEqual({ event: "disconnect" });
    } finally {
      controller.abort();
      diagnostics.unregister();
    }
  });

  it("recovers blocked account identity before publishing a native socket reconnect", async () => {
    const { getSlackClient, getSlackTestState, resetSlackTestState } =
      await import("../monitor.test-helpers.js");
    const { monitorSlackProvider } = await import("./provider.js");
    resetSlackTestState();

    const socket = new EventEmitter();
    const testState = getSlackTestState();
    const authTest = getSlackClient().auth.test;
    let resolveRecoveredAuth: ((value: Record<string, unknown>) => void) | undefined;
    const recoveredAuth = new Promise<Record<string, unknown>>((resolve) => {
      resolveRecoveredAuth = resolve;
    });
    authTest
      .mockImplementationOnce(async () => {
        const receiver = testState.appConstructorArgs?.receiver as {
          client: Pick<EventEmitter, "on" | "off">;
        };
        receiver.client.on = socket.on.bind(socket);
        receiver.client.off = socket.off.bind(socket);
        throw new Error("request_timeout");
      })
      .mockRejectedValueOnce(new Error("request_timeout"))
      .mockImplementationOnce(() => recoveredAuth);
    testState.appStartMock.mockImplementation(async () => {
      socket.emit("connected");
    });

    const controller = new AbortController();
    const setStatus = vi.fn();
    const run = monitorSlackProvider({
      botToken: "bot-token",
      appToken: "app-token",
      abortSignal: controller.signal,
      config: testState.config,
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      setStatus,
    });

    try {
      await vi.waitFor(() => {
        expect(authTest).toHaveBeenCalledTimes(2);
        expect(setStatus).toHaveBeenLastCalledWith(
          expect.objectContaining({
            connected: true,
            lifecycle: "blocked",
            lastError: "request_timeout",
          }),
        );
      });

      socket.emit("close");
      socket.emit("reconnecting");
      expect(setStatus).toHaveBeenLastCalledWith(
        expect.objectContaining({ connected: false, lifecycle: "recovering" }),
      );
      socket.emit("connected");
      expect(authTest).toHaveBeenCalledTimes(3);
      expect(setStatus).toHaveBeenLastCalledWith(
        expect.objectContaining({ connected: false, lifecycle: "recovering" }),
      );

      socket.emit("close");
      expect(setStatus).toHaveBeenLastCalledWith(
        expect.objectContaining({ connected: false, lifecycle: "recovering" }),
      );
      resolveRecoveredAuth?.({
        user_id: "UBOT",
        bot_id: "BBOT",
        app_id: "A_TEST",
        team_id: "T_TEST",
        is_enterprise_install: false,
      });
      await recoveredAuth;
      await Promise.resolve();
      await Promise.resolve();
      expect(setStatus).toHaveBeenLastCalledWith(
        expect.objectContaining({ connected: false, lifecycle: "recovering" }),
      );

      socket.emit("reconnecting");
      socket.emit("connected");
      await vi.waitFor(() => {
        expect(setStatus).toHaveBeenLastCalledWith(
          expect.objectContaining({ connected: true, lifecycle: "ready", lastError: null }),
        );
      });
      expect(testState.appStartMock).toHaveBeenCalledTimes(1);

      socket.emit("close");
      socket.emit("connected");
      controller.abort();
      await run;
      expect(setStatus).toHaveBeenLastCalledWith(
        expect.objectContaining({ connected: false, lifecycle: "recovering" }),
      );
    } finally {
      controller.abort();
      await run;
    }
  });

  it("keeps queued Bolt identity adoption from reviving a disconnected socket", async () => {
    const { getSlackClient, getSlackHandlers, getSlackTestState, resetSlackTestState } =
      await import("../monitor.test-helpers.js");
    const { monitorSlackProvider } = await import("./provider.js");
    resetSlackTestState();

    const socket = new EventEmitter();
    const testState = getSlackTestState();
    const authTest = getSlackClient().auth.test;
    authTest.mockRejectedValue(new Error("request_timeout")).mockImplementationOnce(async () => {
      const receiver = testState.appConstructorArgs?.receiver as {
        client: Pick<EventEmitter, "on" | "off">;
      };
      receiver.client.on = socket.on.bind(socket);
      receiver.client.off = socket.off.bind(socket);
      throw new Error("request_timeout");
    });
    testState.appStartMock.mockImplementation(async () => {
      socket.emit("connected");
    });

    const controller = new AbortController();
    const setStatus = vi.fn();
    const run = monitorSlackProvider({
      botToken: "bot-token",
      appToken: "app-token",
      abortSignal: controller.signal,
      config: testState.config,
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      setStatus,
    });

    try {
      await vi.waitFor(() => {
        expect(setStatus).toHaveBeenLastCalledWith(
          expect.objectContaining({ connected: true, lifecycle: "blocked" }),
        );
      });
      const handler = getSlackHandlers().get("message");
      if (!handler) {
        throw new Error("Slack message handler was not registered");
      }

      socket.emit("close");
      await handler({
        event: { type: "message", user: "URECOVERED" },
        context: {
          botUserId: "URECOVERED",
          botId: "BRECOVERED",
          isEnterpriseInstall: false,
        },
      });
      expect(setStatus).toHaveBeenLastCalledWith(
        expect.objectContaining({ connected: false, lifecycle: "recovering" }),
      );

      socket.emit("reconnecting");
      socket.emit("connected");
      await vi.waitFor(() => {
        expect(setStatus).toHaveBeenLastCalledWith(
          expect.objectContaining({ connected: true, lifecycle: "ready", lastError: null }),
        );
      });
      expect(testState.appStartMock).toHaveBeenCalledTimes(1);
      expect(authTest).toHaveBeenCalledTimes(2);
    } finally {
      controller.abort();
      await run;
    }
  });

  it("ignores pre-start socket events and unregisters every permanent lifecycle observer", () => {
    const client = new EventEmitter();
    const onDisconnected = vi.fn();
    const onReconnected = vi.fn();
    const unrelatedCloseListener = vi.fn();
    client.on("close", unrelatedCloseListener);
    const diagnostics = registerSlackSocketModeConnectionDiagnostics({
      app: { receiver: { client } },
      onSharedConnection: vi.fn(),
      onDisconnected,
      onReconnected,
    });

    client.emit("close");
    client.emit("reconnecting");
    client.emit("connected");
    expect(onDisconnected).not.toHaveBeenCalled();
    expect(onReconnected).not.toHaveBeenCalled();
    const initialConnection = diagnostics.markStartedConnection();
    expect(initialConnection()).toBe(true);

    client.emit("disconnecting");
    expect(initialConnection()).toBe(false);
    client.emit("close");
    expect(onDisconnected).not.toHaveBeenCalled();
    client.emit("connected");
    expect(onReconnected).not.toHaveBeenCalled();
    const nextConnection = diagnostics.markStartedConnection();
    expect(nextConnection()).toBe(true);

    client.emit("close");
    expect(nextConnection()).toBe(false);
    expect(onDisconnected).toHaveBeenCalledTimes(1);
    client.emit("connected");
    expect(onReconnected).toHaveBeenCalledTimes(1);
    const recoveredConnection = diagnostics.markStartedConnection();
    client.emit("connected");
    expect(recoveredConnection()).toBe(true);
    expect(onReconnected).toHaveBeenCalledTimes(1);
    diagnostics.unregister();
    expect(recoveredConnection()).toBe(false);
    client.emit("reconnecting");
    client.emit("connected");
    expect(onDisconnected).toHaveBeenCalledTimes(1);
    expect(onReconnected).toHaveBeenCalledTimes(1);
    expect(client.listenerCount("close")).toBe(1);
    expect(client.listenerCount("error")).toBe(0);
    expect(client.listenerCount("reconnecting")).toBe(0);
    expect(client.listenerCount("connected")).toBe(0);
    expect(client.listenerCount("disconnecting")).toBe(0);
    expect(client.listenerCount("ws_message")).toBe(0);
  });

  it("resolves disconnect waiter on socket disconnect event", async () => {
    const client = new EventEmitter();
    const app = { receiver: { client } };

    const waiter = waitForSlackSocketDisconnect(app as never);
    client.emit("disconnected");

    await expect(waiter).resolves.toEqual({ event: "disconnect" });
  });

  it.each([
    ["error before close", ["error", "close"]],
    ["close before error", ["close", "error"]],
  ] as const)("keeps %s under Slack's native reconnect owner", async (_label, events) => {
    const client = new EventEmitter();
    const error = new Error("dns down");
    const setStatus = vi.fn();
    const controller = new AbortController();
    const nativeErrorListener = vi.fn();
    client.on("error", nativeErrorListener);
    const app = {
      receiver: { client },
      start: vi.fn(async () => {
        client.emit("connected");
      }),
    };
    const diagnostics = registerSlackSocketModeConnectionDiagnostics({
      app,
      onSharedConnection: vi.fn(),
      onDisconnected: (connectionError?: unknown) =>
        publishSlackDisconnectedStatus(setStatus, connectionError),
      onReconnected: () => publishSlackConnectedStatus(setStatus),
    });
    const waiter = startSlackSocketAndWaitForDisconnect({
      app,
      abortSignal: controller.signal,
      onStarted: () => publishSlackConnectedStatus(setStatus),
    });
    await vi.waitFor(() => expect(setStatus).toHaveBeenCalledTimes(1));

    let exited = false;
    void waiter.then(() => {
      exited = true;
    });
    for (const event of events) {
      client.emit(event, ...(event === "error" ? [error] : []));
    }
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(exited).toBe(false);
    expect(nativeErrorListener).toHaveBeenCalledWith(error);
    expect(app.start).toHaveBeenCalledTimes(1);
    expect(setStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ connected: false, lifecycle: "recovering", lastError: "dns down" }),
    );

    client.emit("reconnecting");
    client.emit("connected");
    expect(setStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ connected: true, lifecycle: "ready", lastError: null }),
    );
    expect(app.start).toHaveBeenCalledTimes(1);

    controller.abort();
    await expect(waiter).resolves.toEqual({ event: "disconnect" });
    diagnostics.unregister();
    expect(client.listenerCount("error")).toBe(1);
  });

  it("installs the disconnect waiter before socket start completes", async () => {
    const client = new EventEmitter();
    const app = {
      receiver: { client },
      start: vi.fn().mockImplementation(async () => {
        client.emit("disconnected");
      }),
    };
    const onStarted = vi.fn();

    await expect(
      startSlackSocketAndWaitForDisconnect({
        app: app as never,
        onStarted,
      }),
    ).resolves.toEqual({ event: "disconnect" });

    expect(app.start).toHaveBeenCalledTimes(1);
    expect(onStarted).toHaveBeenCalledTimes(1);
  });

  it("cancels the disconnect waiter when onStarted throws", async () => {
    const client = new EventEmitter();
    const app = {
      receiver: { client },
      start: vi.fn().mockResolvedValue(undefined),
    };
    const err = new Error("status sink failed");

    await expect(
      startSlackSocketAndWaitForDisconnect({
        app: app as never,
        onStarted: () => {
          throw err;
        },
      }),
    ).rejects.toThrow("status sink failed");

    expect(client.listenerCount("disconnected")).toBe(0);
    expect(client.listenerCount("unable_to_socket_mode_start")).toBe(0);
    expect(client.listenerCount("error")).toBe(0);
  });

  it("preserves error payload from unable_to_socket_mode_start event", async () => {
    const client = new EventEmitter();
    const app = { receiver: { client } };
    const err = new Error("invalid_auth");
    const onDisconnected = vi.fn();
    const diagnostics = registerSlackSocketModeConnectionDiagnostics({
      app,
      onSharedConnection: vi.fn(),
      onDisconnected,
      onReconnected: vi.fn(),
    });

    const waiter = waitForSlackSocketDisconnect(app as never);
    client.emit("connected");
    client.emit("close");
    client.emit("unable_to_socket_mode_start", err);

    expect(onDisconnected).toHaveBeenCalledTimes(1);
    await expect(waiter).resolves.toEqual({
      event: "unable_to_socket_mode_start",
      error: err,
    });
    diagnostics.unregister();
  });

  it("uses socket start event error when Bolt rejects without detail", async () => {
    const client = new EventEmitter();
    const err = new Error("missing_scope");
    const app = {
      receiver: { client },
      start: vi.fn().mockImplementation(() => {
        client.emit("unable_to_socket_mode_start", err);
        throw new Error();
      }),
    };

    await expect(startSlackSocketAndWaitForDisconnect({ app: app as never })).rejects.toThrow(
      "missing_scope",
    );

    expect(client.listenerCount("disconnected")).toBe(0);
    expect(client.listenerCount("unable_to_socket_mode_start")).toBe(0);
    expect(client.listenerCount("error")).toBe(0);
  });

  it("marks the socket client as shutting down before stop runs", async () => {
    const app = {
      receiver: { client: { shuttingDown: false } },
      stop: vi.fn().mockImplementation(async () => {
        expect(app.receiver.client.shuttingDown).toBe(true);
      }),
    };

    await gracefulStopSlackApp(app);

    expect(app.stop).toHaveBeenCalledTimes(1);
    expect(app.receiver.client.shuttingDown).toBe(true);
  });
});
