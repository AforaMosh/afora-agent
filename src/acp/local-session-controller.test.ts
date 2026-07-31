import type {
  ListSessionsRequest,
  LoadSessionRequest,
  NewSessionRequest,
  PromptRequest,
  ResumeSessionRequest,
} from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";
import type { AcpEventLedgerReplay } from "./event-ledger.js";
import { AcpLocalSessionBindings } from "./local-session-bindings.js";
import {
  AcpLocalSessionController,
  type AcpLocalSessionControllerOptions,
} from "./local-session-controller.js";
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

function snapshot(mode = "adaptive", timeoutSeconds?: number): SessionSnapshot {
  return {
    configOptions: [
      {
        type: "select",
        id: "thought_level",
        name: "Thought level",
        currentValue: mode,
        options: [{ value: mode, name: mode }],
      },
      {
        type: "select",
        id: "timeout_seconds",
        name: "Turn timeout",
        currentValue: timeoutSeconds ? String(timeoutSeconds) : "inherit",
        options: [
          {
            value: timeoutSeconds ? String(timeoutSeconds) : "inherit",
            name: timeoutSeconds ? String(timeoutSeconds) : "inherit",
          },
        ],
      },
    ],
    modes: {
      currentModeId: mode,
      availableModes: [{ id: mode, name: mode }],
    },
    metadata: {
      title: "Work",
      updatedAt: "2026-07-31T00:00:00.000Z",
      _meta: { sessionKey: "agent:main:work", kind: "direct" },
    },
    usage: { used: 10, size: 100 },
  };
}

function createSessionRuntime(
  overrides: Partial<AcpLocalSessionRuntime> = {},
): AcpLocalSessionRuntime {
  return {
    resolveSessionKey: vi.fn(async ({ fallbackKey }) =>
      fallbackKey.startsWith("agent:") ? fallbackKey : `agent:main:${fallbackKey}`,
    ),
    resetSessionIfNeeded: vi.fn(async () => {}),
    getSessionSnapshot: vi.fn(async (_sessionKey, presentation) =>
      snapshot(presentation?.thinkingLevel ?? "adaptive", presentation?.timeoutSeconds),
    ),
    getExistingSessionSnapshot: vi.fn(async () => snapshot()),
    patchSession: vi.fn(async (_sessionKey, _patch, presentation) =>
      snapshot(presentation?.thinkingLevel ?? "adaptive"),
    ),
    listSessions: vi.fn(async () => []),
    getSessionTranscript: vi.fn(async () => []),
    ...overrides,
  };
}

type TurnRuntimeMocks = {
  cancel: ReturnType<typeof vi.fn>;
  quiesceSession: ReturnType<typeof vi.fn>;
};

function turnRuntimeMocks(runtime: AcpLocalTurnRuntime): TurnRuntimeMocks {
  return runtime as unknown as TurnRuntimeMocks;
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

type SessionUpdatesMock = {
  emit: ReturnType<typeof vi.fn>;
  invalidateLedgerSession: ReturnType<typeof vi.fn>;
  readLedgerReplay: ReturnType<typeof vi.fn>;
  readLedgerReplayBySessionId: ReturnType<typeof vi.fn>;
  readLedgerReplayBySessionKey: ReturnType<typeof vi.fn>;
  sendAvailableCommands: ReturnType<typeof vi.fn>;
  startLedgerSession: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
};

type TestSessionUpdates = AcpTranslatorSessionUpdates & { testMocks: SessionUpdatesMock };

function createSessionUpdates(overrides: Partial<SessionUpdatesMock> = {}): TestSessionUpdates {
  const emptyReplay: AcpEventLedgerReplay = { complete: false, events: [] };
  const mocks: SessionUpdatesMock = {
    emit: vi.fn(async () => {}),
    invalidateLedgerSession: vi.fn(async () => {}),
    readLedgerReplay: vi.fn(async () => emptyReplay),
    readLedgerReplayBySessionId: vi.fn(async () => emptyReplay),
    readLedgerReplayBySessionKey: vi.fn(async () => emptyReplay),
    sendAvailableCommands: vi.fn(async () => {}),
    startLedgerSession: vi.fn(async () => {}),
    stop: vi.fn(),
    ...overrides,
  };
  return Object.assign(mocks as unknown as AcpTranslatorSessionUpdates, { testMocks: mocks });
}

function createController(params: {
  bindings?: AcpLocalSessionBindings;
  sessionRuntime?: AcpLocalSessionRuntime;
  sessionUpdates?: TestSessionUpdates;
  turnRuntime?: AcpLocalTurnRuntime;
  options?: AcpLocalSessionControllerOptions["serverOptions"];
}) {
  const bindings = params.bindings ?? new AcpLocalSessionBindings();
  const sessionRuntime = params.sessionRuntime ?? createSessionRuntime();
  const sessionUpdates = params.sessionUpdates ?? createSessionUpdates();
  const turnRuntime = params.turnRuntime ?? createTurnRuntime();
  return {
    bindings,
    controller: new AcpLocalSessionController({
      bindings,
      sessionRuntime,
      sessionUpdates,
      turnRuntime,
      serverOptions: params.options,
      createSessionId: () => "new-session",
    }),
    sessionRuntime,
    sessionUpdates,
    turnRuntime,
  };
}

function newSessionRequest(meta: Record<string, unknown> = {}): NewSessionRequest {
  return {
    cwd: "/work",
    mcpServers: [],
    _meta: meta,
  } as NewSessionRequest;
}

function loadSessionRequest(
  sessionId: string,
  meta: Record<string, unknown> = {},
): LoadSessionRequest {
  return {
    sessionId,
    cwd: "/work",
    mcpServers: [],
    _meta: meta,
  } as LoadSessionRequest;
}

function resumeSessionRequest(
  sessionId: string,
  meta: Record<string, unknown> = {},
): ResumeSessionRequest {
  return {
    sessionId,
    cwd: "/work",
    mcpServers: [],
    _meta: meta,
  } as ResumeSessionRequest;
}

function promptRequest(sessionId: string): PromptRequest {
  return {
    sessionId,
    prompt: [{ type: "text", text: "hello" }],
    _meta: {},
  } as PromptRequest;
}

describe("AcpLocalSessionController", () => {
  it("quiesces and invalidates sibling bindings before resetting a canonical session", async () => {
    const order: string[] = [];
    const bindings = new AcpLocalSessionBindings();
    await bindings.replace({
      sessionId: "sibling",
      sessionKey: "agent:main:work",
      cwd: "/old",
    });
    const sessionRuntime = createSessionRuntime({
      resolveSessionKey: vi.fn(async () => "agent:main:work"),
      resetSessionIfNeeded: vi.fn(async () => {
        order.push("reset");
      }),
    });
    const turnRuntime = createTurnRuntime({
      quiesceSession: vi.fn(async (sessionId) => {
        order.push(`quiesce:${sessionId}`);
      }),
    });
    const sessionUpdates = createSessionUpdates({
      invalidateLedgerSession: vi.fn(async () => {
        order.push("invalidate");
      }),
      startLedgerSession: vi.fn(async () => {
        order.push("ledger");
      }),
    });
    const { controller } = createController({
      bindings,
      sessionRuntime,
      sessionUpdates,
      turnRuntime,
      options: { resetSession: true },
    });

    const response = await controller.newSession(newSessionRequest());

    expect(response.sessionId).toBe("new-session");
    expect(order).toEqual(["quiesce:sibling", "reset", "invalidate", "ledger"]);
    expect(bindings.get("sibling")).toBeUndefined();
    expect(bindings.get("new-session")).toMatchObject({
      sessionKey: "agent:main:work",
      cwd: "/work",
    });
  });

  it("replays a complete ledger and retains its ledger identity on load", async () => {
    const replay: AcpEventLedgerReplay = {
      complete: true,
      sessionId: "ledger-session",
      sessionKey: "agent:main:work",
      events: [
        {
          seq: 1,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "replayed" },
          },
        },
      ],
    };
    const sessionUpdates = createSessionUpdates({
      readLedgerReplayBySessionId: vi.fn(async () => replay),
    });
    const sessionRuntime = createSessionRuntime({
      resolveSessionKey: vi.fn(async ({ fallbackKey }) => fallbackKey),
      getExistingSessionSnapshot: vi.fn(async () => {
        throw new Error("ledger-only recovery must not require a canonical session row");
      }),
    });
    const { bindings, controller } = createController({ sessionRuntime, sessionUpdates });

    await controller.loadSession(loadSessionRequest("agent:main:work"));

    expect(sessionUpdates.testMocks.emit).toHaveBeenCalledWith({
      sessionId: "agent:main:work",
      update: replay.events[0]?.update,
      record: false,
    });
    expect(bindings.get("agent:main:work")?.ledgerSessionId).toBe("ledger-session");
  });

  it("rejects loading an unknown session without creating a binding", async () => {
    const sessionRuntime = createSessionRuntime({
      getExistingSessionSnapshot: vi.fn(async (sessionKey) => {
        throw new Error(`Session ${sessionKey} not found`);
      }),
    });
    const { bindings, controller, sessionUpdates } = createController({ sessionRuntime });

    await expect(controller.loadSession(loadSessionRequest("missing"))).rejects.toThrow(
      "Session agent:main:missing not found",
    );

    expect(bindings.get("missing")).toBeUndefined();
    expect(sessionUpdates.testMocks.startLedgerSession).not.toHaveBeenCalled();
  });

  it("prefers the current binding ledger over a newer canonical sibling on reload", async () => {
    const bindings = new AcpLocalSessionBindings();
    await bindings.replace({
      sessionId: "session-1",
      sessionKey: "agent:main:work",
      cwd: "/work",
      ledgerSessionId: "ledger-own",
    });
    const ownReplay: AcpEventLedgerReplay = {
      complete: false,
      sessionId: "ledger-own",
      sessionKey: "agent:main:work",
      events: [],
    };
    const siblingReplay: AcpEventLedgerReplay = {
      complete: true,
      sessionId: "ledger-other",
      sessionKey: "agent:main:work",
      events: [],
    };
    const sessionUpdates = createSessionUpdates({
      readLedgerReplay: vi.fn(async ({ sessionId }) =>
        sessionId === "ledger-own" ? ownReplay : { complete: false, events: [] },
      ),
      readLedgerReplayBySessionKey: vi.fn(async () => siblingReplay),
    });
    const sessionRuntime = createSessionRuntime({
      resolveSessionKey: vi.fn(async () => "agent:main:work"),
    });
    const { controller } = createController({
      bindings,
      sessionRuntime,
      sessionUpdates,
    });

    await controller.loadSession(loadSessionRequest("session-1"));

    expect(sessionUpdates.testMocks.readLedgerReplay).toHaveBeenCalledWith({
      sessionId: "ledger-own",
      sessionKey: "agent:main:work",
    });
    expect(bindings.get("session-1")?.ledgerSessionId).toBe("ledger-own");
  });

  it("uses incomplete exact-ledger identity to route transcript fallback", async () => {
    const incompleteReplay: AcpEventLedgerReplay = {
      complete: false,
      sessionId: "acp-session",
      sessionKey: "agent:main:work",
      events: [],
    };
    const siblingReplay: AcpEventLedgerReplay = {
      complete: true,
      sessionId: "sibling-session",
      sessionKey: "agent:main:work",
      events: [],
    };
    const resolveSessionKey = vi.fn(async ({ fallbackKey }) => fallbackKey);
    const getExistingSessionSnapshot = vi.fn(async () => snapshot());
    const sessionUpdates = createSessionUpdates({
      readLedgerReplayBySessionId: vi.fn(async () => incompleteReplay),
      readLedgerReplayBySessionKey: vi.fn(async () => siblingReplay),
    });
    const { bindings, controller } = createController({
      sessionRuntime: createSessionRuntime({
        resolveSessionKey,
        getExistingSessionSnapshot,
      }),
      sessionUpdates,
    });

    await controller.loadSession(loadSessionRequest("acp-session"));

    expect(resolveSessionKey).toHaveBeenCalledWith({
      meta: {},
      fallbackKey: "agent:main:work",
    });
    expect(getExistingSessionSnapshot).toHaveBeenCalledWith("agent:main:work");
    expect(sessionUpdates.testMocks.readLedgerReplayBySessionKey).not.toHaveBeenCalled();
    expect(bindings.get("acp-session")?.ledgerSessionId).toBe("acp-session");
  });

  it("rejects incomplete ledger identity when the canonical session is missing", async () => {
    const sessionUpdates = createSessionUpdates({
      readLedgerReplayBySessionId: vi.fn(async () => ({
        complete: false,
        sessionId: "acp-session",
        sessionKey: "agent:main:missing",
        events: [],
      })),
    });
    const sessionRuntime = createSessionRuntime({
      resolveSessionKey: vi.fn(async ({ fallbackKey }) => fallbackKey),
      getExistingSessionSnapshot: vi.fn(async (sessionKey) => {
        throw new Error(`Session ${sessionKey} not found`);
      }),
    });
    const { bindings, controller } = createController({ sessionRuntime, sessionUpdates });

    await expect(controller.loadSession(loadSessionRequest("acp-session"))).rejects.toThrow(
      "Session agent:main:missing not found",
    );

    expect(bindings.get("acp-session")).toBeUndefined();
    expect(sessionUpdates.testMocks.startLedgerSession).not.toHaveBeenCalled();
  });

  it("quiesces an active binding before selecting the final load replay", async () => {
    const order: string[] = [];
    const bindings = new AcpLocalSessionBindings();
    await bindings.replace({
      sessionId: "session-1",
      sessionKey: "agent:main:work",
      cwd: "/work",
    });
    const sessionUpdates = createSessionUpdates({
      readLedgerReplay: vi.fn(async () => {
        order.push("read-replay");
        return { complete: false, events: [] };
      }),
    });
    const turnRuntime = createTurnRuntime({
      quiesceSession: vi.fn(async () => {
        order.push("quiesce");
      }),
    });
    const sessionRuntime = createSessionRuntime({
      resolveSessionKey: vi.fn(async () => "agent:main:work"),
    });
    const { controller } = createController({
      bindings,
      sessionRuntime,
      sessionUpdates,
      turnRuntime,
    });

    await controller.loadSession(
      loadSessionRequest("session-1", { sessionKey: "agent:main:work" }),
    );

    expect(order).toEqual(["quiesce", "read-replay"]);
  });

  it("captures resume presentation only after the active turn quiesces", async () => {
    const order: string[] = [];
    const bindings = new AcpLocalSessionBindings();
    await bindings.replace({
      sessionId: "session-1",
      sessionKey: "agent:main:work",
      cwd: "/work",
    });
    const sessionRuntime = createSessionRuntime({
      resolveSessionKey: vi.fn(async () => "agent:main:work"),
      getSessionSnapshot: vi.fn(async () => {
        order.push("snapshot");
        return snapshot("high");
      }),
    });
    const turnRuntime = createTurnRuntime({
      quiesceSession: vi.fn(async () => {
        order.push("quiesce");
      }),
    });
    const { controller } = createController({ bindings, sessionRuntime, turnRuntime });

    const response = await controller.resumeSession(resumeSessionRequest("session-1"));

    expect(order).toEqual(["quiesce", "snapshot"]);
    expect(response.modes?.currentModeId).toBe("high");
  });

  it("starts a new ledger boundary on reset without replaying stale history", async () => {
    const replay: AcpEventLedgerReplay = {
      complete: true,
      sessionId: "old-ledger",
      sessionKey: "agent:main:work",
      events: [
        {
          seq: 1,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "stale" },
          },
        },
      ],
    };
    const sessionUpdates = createSessionUpdates({
      readLedgerReplayBySessionId: vi.fn(async () => replay),
    });
    const sessionRuntime = createSessionRuntime({
      resolveSessionKey: vi.fn(async ({ fallbackKey }) => fallbackKey),
    });
    const { bindings, controller } = createController({ sessionRuntime, sessionUpdates });

    await controller.loadSession(loadSessionRequest("agent:main:work", { reset: true }));

    expect(sessionUpdates.testMocks.startLedgerSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "agent:main:work" }),
      { complete: true, reset: true },
    );
    expect(sessionUpdates.testMocks.emit).not.toHaveBeenCalledWith(
      expect.objectContaining({ update: replay.events[0]?.update }),
    );
    expect(bindings.get("agent:main:work")?.ledgerSessionId).toBeUndefined();
  });

  it("keeps the reset replacement bound when client delivery fails", async () => {
    const bindings = new AcpLocalSessionBindings();
    await bindings.replace({
      sessionId: "old-session",
      sessionKey: "agent:main:work",
      cwd: "/old",
      ledgerSessionId: "old-ledger",
    });
    const sessionUpdates = createSessionUpdates({
      sendAvailableCommands: vi.fn(async () => {
        throw new Error("client closed");
      }),
    });
    const sessionRuntime = createSessionRuntime({
      resolveSessionKey: vi.fn(async () => "agent:main:work"),
    });
    const { controller } = createController({
      bindings,
      sessionRuntime,
      sessionUpdates,
      options: { resetSession: true },
    });

    await expect(controller.newSession(newSessionRequest())).rejects.toThrow("client closed");

    expect(sessionUpdates.testMocks.invalidateLedgerSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "old-session",
        ledgerSessionId: "old-ledger",
      }),
    );
    expect(bindings.get("old-session")).toBeUndefined();
    expect(bindings.get("new-session")).toMatchObject({
      sessionKey: "agent:main:work",
      cwd: "/work",
    });
  });

  it("invalidates the current binding ledger when resetting the same canonical session", async () => {
    const bindings = new AcpLocalSessionBindings();
    await bindings.replace({
      sessionId: "session-1",
      sessionKey: "agent:main:work",
      cwd: "/old",
      ledgerSessionId: "old-ledger",
    });
    const sessionUpdates = createSessionUpdates();
    const sessionRuntime = createSessionRuntime({
      resolveSessionKey: vi.fn(async () => "agent:main:work"),
    });
    const { controller } = createController({
      bindings,
      sessionRuntime,
      sessionUpdates,
      options: { resetSession: true },
    });

    await controller.loadSession(loadSessionRequest("session-1"));

    expect(sessionUpdates.testMocks.invalidateLedgerSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        ledgerSessionId: "old-ledger",
      }),
    );
    expect(bindings.get("session-1")?.ledgerSessionId).toBeUndefined();
  });

  it("keeps the prior binding when non-reset setup fails", async () => {
    const bindings = new AcpLocalSessionBindings();
    await bindings.replace({
      sessionId: "session-1",
      sessionKey: "agent:main:old",
      cwd: "/old",
    });
    const sessionUpdates = createSessionUpdates({
      sendAvailableCommands: vi.fn(async () => {
        throw new Error("client closed");
      }),
    });
    const sessionRuntime = createSessionRuntime({
      resolveSessionKey: vi.fn(async () => "agent:main:new"),
    });
    const { controller } = createController({ bindings, sessionRuntime, sessionUpdates });

    await expect(
      controller.loadSession(loadSessionRequest("session-1", { sessionKey: "agent:main:new" })),
    ).rejects.toThrow("client closed");
    expect(bindings.get("session-1")).toMatchObject({
      sessionKey: "agent:main:old",
      cwd: "/old",
    });
    expect(sessionUpdates.testMocks.startLedgerSession).not.toHaveBeenCalled();
  });

  it("pages local sessions with an opaque cwd-bound cursor", async () => {
    const rows = [
      { sessionId: "one", cwd: "/work", title: "One" },
      { sessionId: "two", cwd: "/work", title: "Two" },
      { sessionId: "three", cwd: "/work", title: "Three" },
    ];
    const listSessions = vi.fn(async ({ offset, limit }) => rows.slice(offset, offset + limit));
    const { controller } = createController({
      sessionRuntime: createSessionRuntime({ listSessions }),
    });
    const first = await controller.listSessions({
      cwd: "/work",
      cursor: null,
      _meta: { limit: 2 },
    } as ListSessionsRequest);
    const second = await controller.listSessions({
      cwd: "/work",
      cursor: first.nextCursor,
      _meta: { limit: 2 },
    } as ListSessionsRequest);

    expect(first.sessions.map((entry) => entry.sessionId)).toEqual(["one", "two"]);
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(second.sessions.map((entry) => entry.sessionId)).toEqual(["three"]);
    expect(second.nextCursor).toBeNull();
    await expect(
      controller.listSessions({
        cwd: "/other",
        cursor: first.nextCursor,
        _meta: {},
      } as ListSessionsRequest),
    ).rejects.toThrow("cursor does not match");
  });

  it("holds prompt admission behind an in-flight session transition", async () => {
    const resetStarted = deferred<void>();
    const releaseReset = deferred<void>();
    const prompt = vi.fn(async () => ({ stopReason: "end_turn" as const }));
    const sessionRuntime = createSessionRuntime({
      resetSessionIfNeeded: vi.fn(async () => {
        resetStarted.resolve();
        await releaseReset.promise;
      }),
    });
    const { controller } = createController({
      sessionRuntime,
      turnRuntime: createTurnRuntime({ prompt }),
      options: { resetSession: true },
    });
    const creating = controller.newSession(newSessionRequest());
    await resetStarted.promise;
    const prompting = controller.prompt(promptRequest("new-session"));
    await Promise.resolve();
    expect(prompt).not.toHaveBeenCalled();

    releaseReset.resolve();
    await creating;
    await prompting;
    expect(prompt).toHaveBeenCalledOnce();
  });

  it("allows independent canonical session lifecycles to progress concurrently", async () => {
    const firstDeliveryStarted = deferred<void>();
    const releaseFirstDelivery = deferred<void>();
    const sessionUpdates = createSessionUpdates({
      sendAvailableCommands: vi.fn(async (session: { sessionId: string }) => {
        if (session.sessionId === "session-a") {
          firstDeliveryStarted.resolve();
          await releaseFirstDelivery.promise;
        }
      }),
    });
    const sessionRuntime = createSessionRuntime({
      resolveSessionKey: vi.fn(async ({ meta, fallbackKey }) => meta.sessionKey ?? fallbackKey),
    });
    const { controller } = createController({ sessionRuntime, sessionUpdates });

    const first = controller.loadSession(
      loadSessionRequest("session-a", { sessionKey: "agent:main:a" }),
    );
    await firstDeliveryStarted.promise;
    await expect(
      controller.loadSession(loadSessionRequest("session-b", { sessionKey: "agent:main:b" })),
    ).resolves.toBeDefined();

    releaseFirstDelivery.resolve();
    await first;
  });

  it("stores timeout config in the binding and patches durable modes locally", async () => {
    const bindings = new AcpLocalSessionBindings();
    await bindings.replace({
      sessionId: "session-1",
      sessionKey: "agent:main:work",
      cwd: "/work",
      runtimeOptions: { backendExtras: { verbose: "full" } },
    });
    const sessionRuntime = createSessionRuntime();
    const { controller } = createController({ bindings, sessionRuntime });

    const timeoutResponse = await controller.setSessionConfigOption({
      sessionId: "session-1",
      configId: "timeout",
      value: "45",
      _meta: {},
    });
    await controller.setSessionConfigOption({
      sessionId: "session-1",
      configId: "thought_level",
      value: "medium",
      _meta: {},
    });
    await controller.setSessionMode({
      sessionId: "session-1",
      modeId: "high",
      _meta: {},
    });

    expect(bindings.get("session-1")?.runtimeOptions).toEqual({
      timeoutSeconds: 45,
      backendExtras: { verbose: "full" },
    });
    expect(
      timeoutResponse.configOptions.find((option) => option.id === "timeout_seconds"),
    ).toMatchObject({ currentValue: "45" });
    expect(sessionRuntime.patchSession).toHaveBeenNthCalledWith(
      1,
      "agent:main:work",
      { thinkingLevel: "medium" },
      { thinkingLevel: "medium", spawnedCwd: "/work", timeoutSeconds: 45 },
    );
    expect(sessionRuntime.patchSession).toHaveBeenNthCalledWith(
      2,
      "agent:main:work",
      { thinkingLevel: "high" },
      { thinkingLevel: "high", spawnedCwd: "/work", timeoutSeconds: 45 },
    );
  });

  it("retains ledger identity and runtime options across non-reset resume", async () => {
    const bindings = new AcpLocalSessionBindings();
    await bindings.replace({
      sessionId: "session-1",
      sessionKey: "agent:main:work",
      cwd: "/work",
      ledgerSessionId: "ledger-1",
      runtimeOptions: {
        timeoutSeconds: 30,
        backendExtras: { verbose: "full" },
      },
    });
    const { controller } = createController({ bindings });

    const response = await controller.resumeSession(resumeSessionRequest("session-1"));

    expect(bindings.get("session-1")).toMatchObject({
      ledgerSessionId: "ledger-1",
      runtimeOptions: {
        timeoutSeconds: 30,
        backendExtras: { verbose: "full" },
      },
    });
    expect(response.configOptions?.find((option) => option.id === "timeout_seconds")).toMatchObject(
      { currentValue: "30" },
    );
  });

  it("retains runtime options when loading an existing binding", async () => {
    const bindings = new AcpLocalSessionBindings();
    await bindings.replace({
      sessionId: "session-1",
      sessionKey: "agent:main:work",
      cwd: "/work",
      runtimeOptions: {
        timeoutSeconds: 30,
        backendExtras: { verbose: "full" },
      },
    });
    const sessionRuntime = createSessionRuntime({
      resolveSessionKey: vi.fn(async () => "agent:main:work"),
    });
    const { controller } = createController({ bindings, sessionRuntime });

    await controller.loadSession(loadSessionRequest("session-1"));

    expect(bindings.get("session-1")?.runtimeOptions).toEqual({
      timeoutSeconds: 30,
      backendExtras: { verbose: "full" },
    });
  });

  it("serializes config accepted while load routing is still resolving", async () => {
    const resolveStarted = deferred<void>();
    const releaseResolve = deferred<void>();
    const bindings = new AcpLocalSessionBindings();
    await bindings.replace({
      sessionId: "session-1",
      sessionKey: "agent:main:work",
      cwd: "/work",
      runtimeOptions: { timeoutSeconds: 30 },
    });
    const sessionRuntime = createSessionRuntime({
      resolveSessionKey: vi.fn(async () => {
        resolveStarted.resolve();
        await releaseResolve.promise;
        return "agent:main:work";
      }),
    });
    const { controller } = createController({ bindings, sessionRuntime });

    const loading = controller.loadSession(loadSessionRequest("session-1"));
    await resolveStarted.promise;
    let configSettled = false;
    const configuring = controller
      .setSessionConfigOption({
        sessionId: "session-1",
        configId: "timeout",
        value: "45",
        _meta: {},
      })
      .finally(() => {
        configSettled = true;
      });
    await Promise.resolve();
    expect(configSettled).toBe(false);

    releaseResolve.resolve();
    await loading;
    await configuring;

    expect(bindings.get("session-1")?.runtimeOptions?.timeoutSeconds).toBe(45);
  });

  it("applies queued config changes to the canonical key selected by a rebind", async () => {
    const resetStarted = deferred<void>();
    const releaseReset = deferred<void>();
    const bindings = new AcpLocalSessionBindings();
    await bindings.replace({
      sessionId: "session-1",
      sessionKey: "agent:main:old",
      cwd: "/old",
    });
    const sessionRuntime = createSessionRuntime({
      resolveSessionKey: vi.fn(async () => "agent:main:new"),
      resetSessionIfNeeded: vi.fn(async () => {
        resetStarted.resolve();
        await releaseReset.promise;
      }),
    });
    const { controller } = createController({ bindings, sessionRuntime });

    const loading = controller.loadSession(loadSessionRequest("session-1"));
    await resetStarted.promise;
    const configuring = controller.setSessionConfigOption({
      sessionId: "session-1",
      configId: "timeout",
      value: "45",
      _meta: {},
    });
    releaseReset.resolve();

    await loading;
    await configuring;
    expect(bindings.get("session-1")).toMatchObject({
      sessionKey: "agent:main:new",
      cwd: "/work",
      runtimeOptions: { timeoutSeconds: 45 },
    });
  });

  it("closes the current canonical binding after a queued rebind", async () => {
    const resetStarted = deferred<void>();
    const releaseReset = deferred<void>();
    const bindings = new AcpLocalSessionBindings();
    await bindings.replace({
      sessionId: "session-1",
      sessionKey: "agent:main:old",
      cwd: "/old",
    });
    const sessionRuntime = createSessionRuntime({
      resolveSessionKey: vi.fn(async () => "agent:main:new"),
      resetSessionIfNeeded: vi.fn(async () => {
        resetStarted.resolve();
        await releaseReset.promise;
      }),
    });
    const turnRuntime = createTurnRuntime();
    const { controller } = createController({ bindings, sessionRuntime, turnRuntime });

    const loading = controller.loadSession(loadSessionRequest("session-1"));
    await resetStarted.promise;
    const closing = controller.closeSession({ sessionId: "session-1", _meta: {} });
    releaseReset.resolve();

    await loading;
    await closing;
    expect(turnRuntimeMocks(turnRuntime).quiesceSession).toHaveBeenCalledWith(
      "session-1",
      expect.any(Error),
    );
    expect(bindings.get("session-1")).toBeUndefined();
  });

  it("treats cancellation queued before shutdown as inert once admitted", async () => {
    const deliveryStarted = deferred<void>();
    const releaseDelivery = deferred<void>();
    const bindings = new AcpLocalSessionBindings();
    await bindings.replace({
      sessionId: "session-1",
      sessionKey: "agent:main:work",
      cwd: "/work",
    });
    const sessionUpdates = createSessionUpdates({
      sendAvailableCommands: vi.fn(async () => {
        deliveryStarted.resolve();
        await releaseDelivery.promise;
      }),
    });
    const sessionRuntime = createSessionRuntime({
      resolveSessionKey: vi.fn(async () => "agent:main:work"),
    });
    const turnRuntime = createTurnRuntime();
    const { controller } = createController({
      bindings,
      sessionRuntime,
      sessionUpdates,
      turnRuntime,
    });

    const loading = controller.loadSession(loadSessionRequest("session-1"));
    await deliveryStarted.promise;
    const cancellation = controller.cancel({ sessionId: "session-1", _meta: {} });
    const shuttingDown = controller.shutdown();
    releaseDelivery.resolve();
    await Promise.all([loading, cancellation, shuttingDown]);

    expect(turnRuntimeMocks(turnRuntime).cancel).not.toHaveBeenCalled();
  });

  it("rate-limits new bindings without charging an existing resume", async () => {
    const bindings = new AcpLocalSessionBindings();
    await bindings.replace({
      sessionId: "existing",
      sessionKey: "agent:main:existing",
      cwd: "/work",
    });
    const { controller } = createController({
      bindings,
      options: {
        sessionCreateRateLimit: { maxRequests: 1, windowMs: 60_000 },
      },
    });

    await controller.resumeSession(resumeSessionRequest("existing"));
    await controller.newSession(newSessionRequest());
    await expect(controller.loadSession(loadSessionRequest("new-load"))).rejects.toThrow(
      "rate limit exceeded",
    );
  });

  it("charges the creation budget when an existing ACP id changes canonical target", async () => {
    const bindings = new AcpLocalSessionBindings();
    await bindings.replace({
      sessionId: "existing",
      sessionKey: "agent:main:existing",
      cwd: "/work",
    });
    const sessionRuntime = createSessionRuntime({
      resolveSessionKey: vi.fn(async ({ meta, fallbackKey }) => meta.sessionKey ?? fallbackKey),
    });
    const { controller } = createController({
      bindings,
      sessionRuntime,
      options: {
        sessionCreateRateLimit: { maxRequests: 1, windowMs: 60_000 },
      },
    });

    await controller.loadSession(
      loadSessionRequest("existing", { sessionKey: "agent:main:other" }),
    );
    await expect(controller.newSession(newSessionRequest())).rejects.toThrow("rate limit exceeded");
  });

  it("validates a rebind target before quiescing the current turn", async () => {
    const bindings = new AcpLocalSessionBindings();
    await bindings.replace({
      sessionId: "existing",
      sessionKey: "agent:main:existing",
      cwd: "/work",
    });
    const sessionRuntime = createSessionRuntime({
      resolveSessionKey: vi.fn(async () => "agent:main:missing"),
      getExistingSessionSnapshot: vi.fn(async () => {
        throw new Error("Session agent:main:missing not found");
      }),
    });
    const turnRuntime = createTurnRuntime();
    const { controller } = createController({
      bindings,
      sessionRuntime,
      turnRuntime,
      options: {
        sessionCreateRateLimit: { maxRequests: 5, windowMs: 60_000 },
      },
    });

    await expect(
      controller.resumeSession(
        resumeSessionRequest("existing", { sessionKey: "agent:main:missing" }),
      ),
    ).rejects.toThrow("not found");
    expect(turnRuntimeMocks(turnRuntime).quiesceSession).not.toHaveBeenCalled();
    expect(bindings.get("existing")?.sessionKey).toBe("agent:main:existing");
  });
});
