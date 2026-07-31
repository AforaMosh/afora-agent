import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";
import { AcpLocalAgent } from "./local-agent.js";
import type { AcpLocalSessionController } from "./local-session-controller.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createController() {
  return {
    newSession: vi.fn(async () => ({ sessionId: "session-1" })),
    loadSession: vi.fn(async () => ({ modes: { currentModeId: "default", availableModes: [] } })),
    listSessions: vi.fn(async () => ({ sessions: [], nextCursor: null })),
    resumeSession: vi.fn(async () => ({ configOptions: [] })),
    closeSession: vi.fn(async () => ({})),
    setSessionMode: vi.fn(async () => ({})),
    setSessionConfigOption: vi.fn(async () => ({ configOptions: [] })),
    prompt: vi.fn(async () => ({ stopReason: "end_turn" as const })),
    cancel: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
  };
}

describe("AcpLocalAgent", () => {
  it("advertises only the protocol capabilities implemented by the local controller", async () => {
    const agent = new AcpLocalAgent(createController() as unknown as AcpLocalSessionController);

    const response = await agent.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
    });

    expect(response).toEqual({
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: {
          image: true,
          audio: false,
          embeddedContext: true,
        },
        mcpCapabilities: {
          http: false,
          sse: false,
        },
        sessionCapabilities: {
          list: {},
          resume: {},
          close: {},
        },
      },
      agentInfo: {
        name: "openclaw-acp",
        title: "OpenClaw ACP",
        version: expect.any(String),
      },
      authMethods: [],
    });
    await expect(agent.authenticate({ methodId: "unused" })).rejects.toMatchObject({
      code: -32602,
    });
  });

  it("advertises model setup only when the client can launch terminal authentication", async () => {
    const agent = new AcpLocalAgent(createController() as unknown as AcpLocalSessionController);

    await expect(
      agent.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { auth: { terminal: true } },
      }),
    ).resolves.toMatchObject({
      authMethods: [
        {
          id: "openclaw-model-setup",
          name: "Configure OpenClaw model",
          type: "terminal",
          args: ["configure", "--section", "model"],
        },
      ],
    });
    await expect(agent.authenticate({ methodId: "openclaw-model-setup" })).resolves.toEqual({});
    await expect(agent.authenticate({ methodId: "unused" })).rejects.toMatchObject({
      code: -32602,
    });
    await expect(
      agent.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { auth: { terminal: false } },
      }),
    ).resolves.toMatchObject({ authMethods: [] });
    await expect(agent.authenticate({ methodId: "openclaw-model-setup" })).rejects.toMatchObject({
      code: -32602,
    });
  });

  it("delegates protocol session work without adding another lifecycle owner", async () => {
    const controller = createController();
    const agent = new AcpLocalAgent(controller as unknown as AcpLocalSessionController);
    const newSession = { cwd: "/work", mcpServers: [], _meta: {} };
    const loadSession = { sessionId: "session-1", cwd: "/work", mcpServers: [], _meta: {} };
    const listSessions = { cwd: "/work", cursor: null, _meta: {} };
    const resumeSession = {
      sessionId: "session-1",
      cwd: "/work",
      mcpServers: [],
      _meta: {},
    };
    const closeSession = { sessionId: "session-1", _meta: {} };
    const setMode = { sessionId: "session-1", modeId: "default", _meta: {} };
    const setConfig = {
      sessionId: "session-1",
      configId: "timeout_seconds",
      value: "60",
      _meta: {},
    };
    const prompt = {
      sessionId: "session-1",
      prompt: [{ type: "text" as const, text: "hello" }],
      _meta: {},
    };
    const cancel = { sessionId: "session-1", _meta: {} };

    await expect(agent.newSession(newSession)).resolves.toEqual({ sessionId: "session-1" });
    await expect(agent.loadSession(loadSession)).resolves.toEqual({
      modes: { currentModeId: "default", availableModes: [] },
    });
    await expect(agent.listSessions(listSessions)).resolves.toEqual({
      sessions: [],
      nextCursor: null,
    });
    await expect(agent.resumeSession(resumeSession)).resolves.toEqual({ configOptions: [] });
    await expect(agent.closeSession(closeSession)).resolves.toEqual({});
    await expect(agent.setSessionMode(setMode)).resolves.toEqual({});
    await expect(agent.setSessionConfigOption(setConfig)).resolves.toEqual({ configOptions: [] });
    await expect(agent.prompt(prompt)).resolves.toEqual({ stopReason: "end_turn" });
    await agent.cancel(cancel);

    expect(controller.newSession).toHaveBeenCalledWith(newSession);
    expect(controller.loadSession).toHaveBeenCalledWith(loadSession);
    expect(controller.listSessions).toHaveBeenCalledWith(listSessions);
    expect(controller.resumeSession).toHaveBeenCalledWith(resumeSession);
    expect(controller.closeSession).toHaveBeenCalledWith(closeSession);
    expect(controller.setSessionMode).toHaveBeenCalledWith(setMode);
    expect(controller.setSessionConfigOption).toHaveBeenCalledWith(setConfig);
    expect(controller.prompt).toHaveBeenCalledWith(prompt);
    expect(controller.cancel).toHaveBeenCalledWith(cancel);
  });

  it("delegates shutdown and preserves its completion boundary", async () => {
    const release = deferred<void>();
    const controller = createController();
    controller.shutdown.mockImplementation(async () => {
      await release.promise;
    });
    const agent = new AcpLocalAgent(controller as unknown as AcpLocalSessionController);
    const reason = new Error("connection closed");

    const shutdown = agent.shutdown(reason);
    expect(controller.shutdown).toHaveBeenCalledWith(reason);
    let settled = false;
    void shutdown.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    release.resolve();
    await shutdown;
    expect(settled).toBe(true);
  });
});
