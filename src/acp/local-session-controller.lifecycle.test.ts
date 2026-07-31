import type {
  LoadSessionRequest,
  PromptRequest,
  ResumeSessionRequest,
} from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";
import { AcpLocalSessionBindings } from "./local-session-bindings.js";
import { AcpLocalSessionController } from "./local-session-controller.js";
import type { AcpLocalSessionRuntime } from "./local-session-runtime.js";
import type { AcpLocalTurnRuntime } from "./local-turn-runtime.js";
import type { SessionSnapshot } from "./translator.presentation.js";
import type { AcpTranslatorSessionUpdates } from "./translator.session-updates.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function snapshot(): SessionSnapshot {
  return {
    configOptions: [],
    modes: {
      currentModeId: "adaptive",
      availableModes: [{ id: "adaptive", name: "Adaptive" }],
    },
  };
}

function createSessionRuntime(
  overrides: Partial<AcpLocalSessionRuntime> = {},
): AcpLocalSessionRuntime {
  return {
    resolveSessionKey: vi.fn(async ({ fallbackKey }) => fallbackKey),
    resetSessionIfNeeded: vi.fn(async () => {}),
    getSessionSnapshot: vi.fn(async () => snapshot()),
    getExistingSessionSnapshot: vi.fn(async () => snapshot()),
    patchSession: vi.fn(async () => snapshot()),
    listSessions: vi.fn(async () => []),
    getSessionTranscript: vi.fn(async () => []),
    ...overrides,
  };
}

function createTurnRuntime(overrides: Partial<AcpLocalTurnRuntime> = {}): AcpLocalTurnRuntime {
  return {
    activeRunCount: vi.fn(() => 0),
    activeSessionIds: vi.fn(() => new Set()),
    prompt: vi.fn(async () => ({ stopReason: "end_turn" })),
    cancel: vi.fn(async () => {}),
    quiesceSession: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
    ...overrides,
  } as unknown as AcpLocalTurnRuntime;
}

type TurnRuntimeMocks = {
  cancel: ReturnType<typeof vi.fn>;
  quiesceSession: ReturnType<typeof vi.fn>;
};

function turnRuntimeMocks(runtime: AcpLocalTurnRuntime): TurnRuntimeMocks {
  return runtime as unknown as TurnRuntimeMocks;
}

function createSessionUpdates() {
  const updates = {
    emit: vi.fn(async () => {}),
    invalidateLedgerSession: vi.fn(async () => {}),
    readLedgerReplay: vi.fn(async () => ({ complete: false as const, events: [] })),
    readLedgerReplayBySessionId: vi.fn(async () => ({ complete: false as const, events: [] })),
    readLedgerReplayBySessionKey: vi.fn(async () => ({ complete: false as const, events: [] })),
    sendAvailableCommands: vi.fn(async () => {}),
    startLedgerSession: vi.fn(async () => {}),
    stop: vi.fn(),
  };
  return updates as unknown as AcpTranslatorSessionUpdates & typeof updates;
}

function createController(params: {
  bindings?: AcpLocalSessionBindings;
  sessionRuntime?: AcpLocalSessionRuntime;
  resetSession?: boolean;
  turnRuntime?: AcpLocalTurnRuntime;
}) {
  const bindings = params.bindings ?? new AcpLocalSessionBindings();
  const sessionRuntime = params.sessionRuntime ?? createSessionRuntime();
  const sessionUpdates = createSessionUpdates();
  const turnRuntime = params.turnRuntime ?? createTurnRuntime();
  const controller = new AcpLocalSessionController({
    bindings,
    sessionRuntime,
    sessionUpdates,
    turnRuntime,
    serverOptions: params.resetSession ? { resetSession: true } : undefined,
  });
  return { controller, sessionUpdates, turnRuntime };
}

function sessionRequest(method: "load" | "resume", sessionId: string) {
  return {
    sessionId,
    cwd: "/work",
    mcpServers: [],
    _meta: {},
  } as LoadSessionRequest & ResumeSessionRequest;
}

function promptRequest(sessionId: string): PromptRequest {
  return {
    sessionId,
    prompt: [{ type: "text", text: "hello" }],
    _meta: {},
  } as PromptRequest;
}

describe("AcpLocalSessionController lifecycle ordering", () => {
  it("does not let shutdown overtake new-session routing", async () => {
    const routingStarted = deferred<void>();
    const releaseRouting = deferred<void>();
    const bindings = new AcpLocalSessionBindings();
    const sessionRuntime = createSessionRuntime({
      resolveSessionKey: vi.fn(async () => {
        routingStarted.resolve();
        await releaseRouting.promise;
        return "agent:main:new";
      }),
    });
    const shutdown = vi.fn(async () => {});
    const turnRuntime = createTurnRuntime({ shutdown });
    const { controller, sessionUpdates } = createController({
      bindings,
      sessionRuntime,
      turnRuntime,
    });

    const creating = controller.newSession({
      cwd: "/work",
      mcpServers: [],
      _meta: {},
    });
    await routingStarted.promise;
    let shutdownSettled = false;
    const shuttingDown = controller.shutdown().finally(() => {
      shutdownSettled = true;
    });
    await Promise.resolve();
    expect(shutdownSettled).toBe(false);

    releaseRouting.resolve();
    await expect(creating).resolves.toMatchObject({ sessionId: expect.any(String) });
    await shuttingDown;

    expect(bindings.list()).toEqual([]);
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(sessionUpdates.stop).toHaveBeenCalledTimes(1);
  });

  it.each(["load", "resume"] as const)(
    "does not let close overtake %s while routing is pending",
    async (method) => {
      const routingStarted = deferred<void>();
      const releaseRouting = deferred<void>();
      const bindings = new AcpLocalSessionBindings();
      await bindings.replace({
        sessionId: "session-1",
        sessionKey: "agent:main:old",
        cwd: "/old",
      });
      const sessionRuntime = createSessionRuntime({
        resolveSessionKey: vi.fn(async () => {
          routingStarted.resolve();
          await releaseRouting.promise;
          return "agent:main:new";
        }),
      });
      const { controller } = createController({ bindings, sessionRuntime });

      const routing =
        method === "load"
          ? controller.loadSession(sessionRequest(method, "session-1"))
          : controller.resumeSession(sessionRequest(method, "session-1"));
      await routingStarted.promise;
      let closeSettled = false;
      const closing = controller.closeSession({ sessionId: "session-1", _meta: {} }).finally(() => {
        closeSettled = true;
      });
      await Promise.resolve();
      expect(closeSettled).toBe(false);

      releaseRouting.resolve();
      await routing;
      await closing;
      expect(bindings.get("session-1")).toBeUndefined();
    },
  );

  it.each(["load", "resume"] as const)(
    "does not let prompt admission overtake %s while routing is pending",
    async (method) => {
      const routingStarted = deferred<void>();
      const releaseRouting = deferred<void>();
      const bindings = new AcpLocalSessionBindings();
      await bindings.replace({
        sessionId: "session-1",
        sessionKey: "agent:main:old",
        cwd: "/old",
      });
      const sessionRuntime = createSessionRuntime({
        resolveSessionKey: vi.fn(async () => {
          routingStarted.resolve();
          await releaseRouting.promise;
          return "agent:main:new";
        }),
      });
      const prompt = vi.fn(async () => ({ stopReason: "end_turn" as const }));
      const turnRuntime = createTurnRuntime({ prompt });
      const { controller } = createController({ bindings, sessionRuntime, turnRuntime });

      const routing =
        method === "load"
          ? controller.loadSession(sessionRequest(method, "session-1"))
          : controller.resumeSession(sessionRequest(method, "session-1"));
      await routingStarted.promise;
      const prompting = controller.prompt(promptRequest("session-1"));
      await Promise.resolve();
      expect(prompt).not.toHaveBeenCalled();

      releaseRouting.resolve();
      await routing;
      await expect(prompting).resolves.toEqual({ stopReason: "end_turn" });
      expect(prompt).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "session-1",
          sessionKey: "agent:main:new",
          cwd: "/work",
        }),
        expect.objectContaining({ sessionId: "session-1" }),
      );
    },
  );

  it("closes sessions and performs idempotent ordered shutdown", async () => {
    const order: string[] = [];
    const bindings = new AcpLocalSessionBindings();
    await bindings.replace({
      sessionId: "close-me",
      sessionKey: "agent:main:close",
      cwd: "/work",
    });
    await bindings.replace({
      sessionId: "shutdown-me",
      sessionKey: "agent:main:shutdown",
      cwd: "/work",
    });
    const turnRuntime = createTurnRuntime({
      quiesceSession: vi.fn(async () => {
        order.push("quiesce");
      }),
      shutdown: vi.fn(async () => {
        order.push("turn-shutdown");
      }),
    });
    const { controller, sessionUpdates } = createController({ bindings, turnRuntime });
    sessionUpdates.stop.mockImplementation(() => {
      order.push("updates-stop");
    });

    await controller.closeSession({ sessionId: "close-me", _meta: {} });
    const firstShutdown = controller.shutdown();
    const secondShutdown = controller.shutdown();
    expect(secondShutdown).toBe(firstShutdown);
    await firstShutdown;

    expect(order).toEqual(["quiesce", "turn-shutdown", "updates-stop"]);
    expect(bindings.list()).toEqual([]);
    await expect(controller.resumeSession(sessionRequest("resume", "late"))).rejects.toThrow(
      "controller is stopped",
    );
  });

  it("closes only the requested binding when canonical sessions are shared", async () => {
    const bindings = new AcpLocalSessionBindings();
    await bindings.replace({
      sessionId: "session-1",
      sessionKey: "agent:main:shared",
      cwd: "/one",
    });
    await bindings.replace({
      sessionId: "session-2",
      sessionKey: "agent:main:shared",
      cwd: "/two",
    });
    const turnRuntime = createTurnRuntime();
    const { controller } = createController({ bindings, turnRuntime });

    await controller.closeSession({ sessionId: "session-1", _meta: {} });

    expect(turnRuntimeMocks(turnRuntime).quiesceSession).toHaveBeenCalledWith(
      "session-1",
      expect.any(Error),
    );
    expect(bindings.get("session-1")).toBeUndefined();
    expect(bindings.get("session-2")).toBeDefined();
  });

  it("rejects close when the session is absent or already closed", async () => {
    const bindings = new AcpLocalSessionBindings();
    await bindings.replace({
      sessionId: "session-1",
      sessionKey: "agent:main:work",
      cwd: "/work",
    });
    const { controller } = createController({ bindings });

    await controller.closeSession({ sessionId: "session-1", _meta: {} });
    await expect(controller.closeSession({ sessionId: "session-1", _meta: {} })).rejects.toThrow(
      "Session session-1 not found",
    );
    await expect(controller.closeSession({ sessionId: "missing", _meta: {} })).rejects.toThrow(
      "Session missing not found",
    );
  });

  it("treats cancellation after shutdown as an inert notification", async () => {
    const turnRuntime = createTurnRuntime();
    const { controller } = createController({ turnRuntime });

    await controller.shutdown();
    await controller.cancel({ sessionId: "late", _meta: {} });

    expect(turnRuntimeMocks(turnRuntime).cancel).not.toHaveBeenCalled();
  });

  it("preserves the prior binding and complete ledger when durable reset fails", async () => {
    const bindings = new AcpLocalSessionBindings();
    await bindings.replace({
      sessionId: "session-1",
      sessionKey: "agent:main:work",
      cwd: "/old",
      ledgerSessionId: "old-ledger",
    });
    const sessionRuntime = createSessionRuntime({
      resolveSessionKey: vi.fn(async () => "agent:main:work"),
      resetSessionIfNeeded: vi.fn(async () => {
        throw new Error("reset failed");
      }),
    });
    const { controller, sessionUpdates } = createController({
      bindings,
      sessionRuntime,
      resetSession: true,
    });

    await expect(controller.loadSession(sessionRequest("load", "session-1"))).rejects.toThrow(
      "reset failed",
    );
    expect(sessionUpdates.invalidateLedgerSession).not.toHaveBeenCalled();
    expect(bindings.get("session-1")).toMatchObject({
      sessionKey: "agent:main:work",
      cwd: "/old",
      ledgerSessionId: "old-ledger",
    });
  });
});
