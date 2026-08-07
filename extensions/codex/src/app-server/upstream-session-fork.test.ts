import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexSessionCatalogControl } from "../session-catalog-types.js";
import type {
  CodexThread,
  CodexThreadForkParams,
  CodexThreadListResponse,
  CodexTurn,
} from "./protocol.js";
import { sessionBindingIdentity, type CodexAppServerBindingStore } from "./session-binding.js";
import {
  resetCodexTestBindingStore,
  seedCodexTestBindingForIdentity,
  seedRetiredLegacyMcpThread,
  testCodexAppServerBindingStore,
} from "./session-binding.test-helpers.js";

const boundaryMocks = vi.hoisted(() => ({
  listTurns: vi.fn(),
}));
const linkMocks = vi.hoisted(() => ({
  delete: vi.fn(),
  upsert: vi.fn(),
}));
const transcriptMocks = vi.hoisted(() => ({
  importHistory: vi.fn(),
}));

const boundary = {
  beforeTurnId: "turn-2",
  targetTurnId: "turn-2",
  retainedMarker: { turnId: "turn-1", userMessageCount: 1 },
} as const;

vi.mock("openclaw/plugin-sdk/session-catalog", async (importOriginal) => ({
  ...(await importOriginal()),
  deleteSessionUpstreamLink: linkMocks.delete,
  upsertSessionUpstreamLink: linkMocks.upsert,
}));

vi.mock("./transcript-mirror.js", () => ({
  importCodexThreadHistoryToTranscript: transcriptMocks.importHistory,
}));

vi.mock("./upstream-fork-boundary.js", () => ({
  resolveCodexUpstreamForkBoundary: vi.fn(async () => ({
    ok: true,
    boundary,
    editorText: "edit me",
  })),
  listCodexUpstreamTurns: boundaryMocks.listTurns,
  precheckCodexUpstreamForkBoundary: vi.fn(() => ({ ok: true, boundary })),
}));

import { forkCodexUpstreamSession } from "./upstream-session-fork.js";

function turn(id: string, text: string): CodexTurn {
  return {
    id,
    status: "completed",
    items: [
      {
        aggregatedOutput: null,
        changes: [],
        command: null,
        cwd: null,
        id: `${id}-user`,
        name: null,
        query: null,
        server: null,
        status: null,
        text: "",
        title: null,
        tool: null,
        content: [{ type: "text", text, textElements: [] }],
        type: "userMessage",
      },
    ],
  };
}

function forkResponse(threadId = "thread-forked") {
  return {
    approvalPolicy: "never",
    approvalsReviewer: "user",
    cwd: "/tmp",
    model: "gpt-5.4",
    modelProvider: "openai",
    sandbox: { type: "dangerFullAccess" },
    thread: {
      id: threadId,
      sessionId: "session-forked",
      cliVersion: "0.146.1",
      createdAt: 1715299200,
      updatedAt: 1715299200,
      cwd: "/tmp",
      ephemeral: false,
      modelProvider: "openai",
      preview: "forked thread",
      source: "appServer",
      status: { type: "notLoaded" },
      turns: [],
    },
  };
}

function forkParams() {
  return {
    targetKey: "agent:main:dashboard:forked",
    source: {
      agentId: "main",
      sessionId: "session-source",
      sessionKey: "agent:main:source",
      storePath: "/tmp/sessions.db",
      entryId: "entry-2",
    },
    upstream: {
      catalogId: "codex",
      hostId: "gateway:local",
      kind: "codex-app-server" as const,
      threadId: "thread-source",
      ref: { connectionFingerprint: "fingerprint", threadId: "thread-source" },
    },
  };
}

type ForkThreadStub = (params: CodexThreadForkParams) => Promise<unknown>;

function forkControl(forkThread: ForkThreadStub = vi.fn(async () => forkResponse())) {
  const archiveThread = vi.fn(async () => undefined);
  const listDescendantPage = vi.fn(
    async (): Promise<CodexThreadListResponse> => ({ data: [], nextCursor: null }),
  );
  const readThread = vi.fn(
    async (threadId: string): Promise<CodexThread> => ({
      id: threadId,
      status: { type: "idle" as const },
    }),
  );
  const control = {
    archiveThread,
    clientId: "client-pinned",
    connectionFingerprint: "fingerprint",
    forkThread,
    listDescendantPage,
    readThread,
  } as unknown as CodexSessionCatalogControl;
  control.withPinnedConnection = async <T>(
    run: (control: CodexSessionCatalogControl) => Promise<T>,
  ) => await run(control);
  return { archiveThread, control, forkThread, listDescendantPage, readThread };
}

function forkBindingStore(
  mutate = vi.fn(async () => true),
  ownership = { hasUnexpectedOwner: false, hasLegacyNativeMcpOwner: false },
): CodexAppServerBindingStore {
  return {
    hasLegacyMcpRetirementState: vi.fn(async () => false),
    inspectThreadOwnership: vi.fn(async () => ownership),
    mutate,
    read: vi.fn(async () => undefined),
    withThreadArchiveFence: async <T>(run: () => Promise<T>) => await run(),
  } as unknown as CodexAppServerBindingStore;
}

beforeEach(() => {
  resetCodexTestBindingStore();
  boundaryMocks.listTurns.mockReset();
  linkMocks.delete.mockReset();
  linkMocks.upsert.mockReset().mockReturnValue(true);
  transcriptMocks.importHistory.mockReset().mockResolvedValue({
    importedMessages: 1,
    omittedMessages: 0,
  });
});

describe("forkCodexUpstreamSession", () => {
  it("verifies the cut, imports the fork history, then links before binding", async () => {
    const retainedTurn = turn("turn-1", "one");
    boundaryMocks.listTurns
      .mockResolvedValueOnce([turn("turn-2", "edit me")])
      .mockResolvedValueOnce([retainedTurn]);
    const { archiveThread, control, forkThread } = forkControl();
    const events: string[] = [];
    linkMocks.upsert.mockImplementation(() => {
      events.push("link");
      return true;
    });
    const mutate = vi.fn(async () => {
      events.push("bind");
      return true;
    });
    const runtime = createPluginRuntimeMock();
    const createSessionEntry = vi.mocked(runtime.agent.session.createSessionEntry);

    const result = await forkCodexUpstreamSession(forkParams(), {
      bindingStore: forkBindingStore(mutate),
      control,
      harnessRuntimeId: "codex-custom",
      resolveConfig: () => ({}),
      runtime,
    });

    expect(forkThread).toHaveBeenCalledWith({
      threadId: "thread-source",
      beforeTurnId: "turn-2",
      excludeTurns: true,
    });
    expect(boundaryMocks.listTurns).toHaveBeenLastCalledWith(control, "thread-forked");
    expect(transcriptMocks.importHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:dashboard:forked",
        thread: expect.objectContaining({ id: "thread-forked", turns: [retainedTurn] }),
        throughTurnId: "turn-1",
      }),
    );
    expect(linkMocks.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        marker: { turnId: "turn-1", userMessageCount: 1 },
        sessionKey: "agent:main:dashboard:forked",
        threadId: "thread-forked",
      }),
    );
    expect(runtime.agent.session.createSessionEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        initialEntry: expect.objectContaining({ agentHarnessId: "codex-custom" }),
      }),
    );
    expect(createSessionEntry.mock.calls[0]?.[0]).not.toHaveProperty("recoverMatchingInitialEntry");
    expect(events).toEqual(["link", "bind"]);
    expect(result).toEqual({
      status: "created",
      key: "agent:main:dashboard:forked",
      editorText: "edit me",
    });
    expect(archiveThread).not.toHaveBeenCalled();
  });

  it("forks incognito sessions ephemerally and imports history from the live response", async () => {
    const retainedTurn = turn("turn-1", "one");
    boundaryMocks.listTurns.mockResolvedValueOnce([turn("turn-2", "edit me")]);
    const forkThread = vi.fn(async () => {
      const response = forkResponse();
      return {
        ...response,
        thread: { ...response.thread, ephemeral: true, turns: [retainedTurn] },
      };
    });
    const { control } = forkControl(forkThread);
    const params = forkParams();
    params.targetKey = "agent:main:dashboard:incognito-forked";
    const mutate = vi.fn(async () => true);

    await expect(
      forkCodexUpstreamSession(params, {
        bindingStore: forkBindingStore(mutate),
        control,
        harnessRuntimeId: "codex",
        resolveConfig: () => ({}),
        runtime: createPluginRuntimeMock(),
      }),
    ).resolves.toMatchObject({ status: "created", key: params.targetKey });

    expect(forkThread).toHaveBeenCalledWith({
      threadId: "thread-source",
      beforeTurnId: "turn-2",
      ephemeral: true,
      excludeTurns: false,
    });
    expect(boundaryMocks.listTurns).toHaveBeenCalledTimes(1);
    expect(transcriptMocks.importHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: params.targetKey,
        thread: expect.objectContaining({
          turns: expect.arrayContaining([expect.objectContaining({ id: retainedTurn.id })]),
        }),
      }),
    );
    expect(mutate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        kind: "set",
        binding: expect.objectContaining({ clientId: "client-pinned" }),
      }),
    );
  });

  it("archives a fork whose read-back history proves beforeTurnId was ignored", async () => {
    boundaryMocks.listTurns
      .mockResolvedValueOnce([turn("turn-2", "edit me")])
      .mockResolvedValueOnce([turn("turn-1", "one"), turn("turn-2", "edit me")]);
    const { archiveThread, control } = forkControl();
    const runtime = createPluginRuntimeMock();

    const result = await forkCodexUpstreamSession(forkParams(), {
      bindingStore: forkBindingStore(vi.fn()),
      control,
      harnessRuntimeId: "codex",
      runtime,
    });

    expect(result).toMatchObject({
      status: "failed",
      code: "upstream-unavailable",
      message: expect.stringContaining("Codex version"),
    });
    expect(archiveThread).toHaveBeenCalledWith("thread-forked");
    expect(runtime.agent.session.createSessionEntry).not.toHaveBeenCalled();
    expect(linkMocks.upsert).not.toHaveBeenCalled();
  });

  it("cleans the link and archives the fork when binding materialization fails", async () => {
    boundaryMocks.listTurns
      .mockResolvedValueOnce([turn("turn-2", "edit me")])
      .mockResolvedValueOnce([turn("turn-1", "one")]);
    const { archiveThread, control } = forkControl();
    const mutate = vi.fn(async () => false);

    const result = await forkCodexUpstreamSession(forkParams(), {
      bindingStore: forkBindingStore(mutate),
      control,
      harnessRuntimeId: "codex",
      runtime: createPluginRuntimeMock(),
    });

    expect(result).toMatchObject({ status: "failed", code: "upstream-unavailable" });
    expect(linkMocks.delete).toHaveBeenCalledWith("agent:main:dashboard:forked", "main", {
      expected: {
        catalogId: "codex",
        hostId: "gateway:local",
        threadId: "thread-forked",
        upstreamKind: "codex-app-server",
        upstreamRef: { connectionFingerprint: "fingerprint", threadId: "thread-forked" },
      },
    });
    expect(mutate).toHaveBeenLastCalledWith(expect.anything(), {
      kind: "clear",
      threadId: "thread-forked",
    });
    expect(archiveThread).toHaveBeenCalledWith("thread-forked");
  });

  it("does not trust or archive an orphan id from an invalid fork response", async () => {
    boundaryMocks.listTurns.mockResolvedValueOnce([turn("turn-2", "edit me")]);
    const { archiveThread, control } = forkControl(
      vi.fn(async () => ({ thread: { id: "thread-orphan" } })),
    );

    const result = await forkCodexUpstreamSession(forkParams(), {
      bindingStore: forkBindingStore(),
      control,
      harnessRuntimeId: "codex",
      runtime: createPluginRuntimeMock(),
    });

    expect(result).toMatchObject({ status: "failed", code: "upstream-unavailable" });
    expect(archiveThread).not.toHaveBeenCalled();
  });

  it("preserves a failed fork when it already has a native descendant", async () => {
    boundaryMocks.listTurns
      .mockResolvedValueOnce([turn("turn-2", "edit me")])
      .mockResolvedValueOnce([turn("turn-1", "one"), turn("turn-2", "edit me")]);
    const { archiveThread, control, listDescendantPage } = forkControl();
    listDescendantPage.mockResolvedValueOnce({
      data: [{ id: "thread-detached-descendant" }],
      nextCursor: null,
    });

    const result = await forkCodexUpstreamSession(forkParams(), {
      bindingStore: forkBindingStore(vi.fn()),
      control,
      harnessRuntimeId: "codex",
      runtime: createPluginRuntimeMock(),
    });

    expect(result).toMatchObject({ status: "failed", code: "upstream-unavailable" });
    expect(archiveThread).not.toHaveBeenCalled();
    expect(linkMocks.delete).not.toHaveBeenCalled();
  });

  it("rejects a fork response that reuses the source thread id", async () => {
    boundaryMocks.listTurns.mockResolvedValueOnce([turn("turn-2", "edit me")]);
    const { archiveThread, control } = forkControl(
      vi.fn(async () => forkResponse("thread-source")),
    );

    const result = await forkCodexUpstreamSession(forkParams(), {
      bindingStore: forkBindingStore(vi.fn()),
      control,
      harnessRuntimeId: "codex",
      runtime: createPluginRuntimeMock(),
    });

    expect(result).toMatchObject({ status: "failed", code: "upstream-unavailable" });
    expect(archiveThread).not.toHaveBeenCalled();
  });

  it("rejects a persisted upstream source owned by another OpenClaw binding", async () => {
    boundaryMocks.listTurns.mockResolvedValueOnce([turn("turn-2", "edit me")]);
    const { control, forkThread } = forkControl();

    const result = await forkCodexUpstreamSession(forkParams(), {
      bindingStore: forkBindingStore(vi.fn(), {
        hasUnexpectedOwner: true,
        hasLegacyNativeMcpOwner: true,
      }),
      control,
      harnessRuntimeId: "codex",
      runtime: createPluginRuntimeMock(),
    });

    expect(result).toMatchObject({ status: "failed", code: "upstream-unavailable" });
    expect(forkThread).not.toHaveBeenCalled();
  });

  it("allows the exact source session owner but rejects an additional owner", async () => {
    const params = forkParams();
    const sourceIdentity = sessionBindingIdentity({
      agentId: params.source.agentId,
      sessionId: params.source.sessionId,
      sessionKey: params.source.sessionKey,
      config: {},
    });
    await testCodexAppServerBindingStore.mutate(sourceIdentity, {
      kind: "set",
      binding: { threadId: params.upstream.threadId, cwd: "/tmp" },
    });
    boundaryMocks.listTurns
      .mockResolvedValueOnce([turn("turn-2", "edit me")])
      .mockResolvedValueOnce([turn("turn-1", "one")]);
    const first = forkControl();

    await expect(
      forkCodexUpstreamSession(params, {
        bindingStore: testCodexAppServerBindingStore,
        control: first.control,
        harnessRuntimeId: "codex",
        resolveConfig: () => ({}),
        runtime: createPluginRuntimeMock(),
      }),
    ).resolves.toMatchObject({ status: "created" });
    expect(first.forkThread).toHaveBeenCalledOnce();

    resetCodexTestBindingStore();
    await testCodexAppServerBindingStore.mutate(sourceIdentity, {
      kind: "set",
      binding: { threadId: params.upstream.threadId, cwd: "/tmp" },
    });
    await testCodexAppServerBindingStore.mutate(
      { kind: "conversation", bindingId: "third-owner" },
      { kind: "set", binding: { threadId: params.upstream.threadId, cwd: "/tmp" } },
    );
    boundaryMocks.listTurns.mockReset().mockResolvedValueOnce([turn("turn-2", "edit me")]);
    const second = forkControl();

    await expect(
      forkCodexUpstreamSession(params, {
        bindingStore: testCodexAppServerBindingStore,
        control: second.control,
        harnessRuntimeId: "codex",
        resolveConfig: () => ({}),
        runtime: createPluginRuntimeMock(),
      }),
    ).resolves.toMatchObject({ status: "failed", code: "upstream-unavailable" });
    expect(second.forkThread).not.toHaveBeenCalled();
  });

  it("rejects an exact source owner that still carries legacy MCP provenance", async () => {
    const params = forkParams();
    seedCodexTestBindingForIdentity(
      sessionBindingIdentity({
        agentId: params.source.agentId,
        sessionId: params.source.sessionId,
        sessionKey: params.source.sessionKey,
        config: {},
      }),
      {
        threadId: params.upstream.threadId,
        cwd: "/tmp",
        userMcpServersFingerprint: "legacy-mcp",
      },
    );
    boundaryMocks.listTurns.mockResolvedValueOnce([turn("turn-2", "edit me")]);
    const { control, forkThread } = forkControl();

    await expect(
      forkCodexUpstreamSession(params, {
        bindingStore: testCodexAppServerBindingStore,
        control,
        harnessRuntimeId: "codex",
        resolveConfig: () => ({}),
        runtime: createPluginRuntimeMock(),
      }),
    ).resolves.toMatchObject({ status: "failed", code: "upstream-unavailable" });
    expect(forkThread).not.toHaveBeenCalled();
  });

  it("rejects an upstream fork descended from retired configured MCP authority", async () => {
    const params = forkParams();
    const sourceIdentity = sessionBindingIdentity({
      agentId: params.source.agentId,
      sessionId: params.source.sessionId,
      sessionKey: params.source.sessionKey,
      config: {},
    });
    await testCodexAppServerBindingStore.mutate(sourceIdentity, {
      kind: "set",
      binding: { threadId: params.upstream.threadId, cwd: "/tmp" },
    });
    await seedRetiredLegacyMcpThread("thread-retired-root");
    boundaryMocks.listTurns.mockResolvedValueOnce([turn("turn-2", "edit me")]);
    const { control, forkThread, readThread } = forkControl();
    readThread.mockResolvedValue({
      id: params.upstream.threadId,
      parentThreadId: "thread-retired-root",
      status: { type: "idle" },
    });

    await expect(
      forkCodexUpstreamSession(params, {
        bindingStore: testCodexAppServerBindingStore,
        control,
        harnessRuntimeId: "codex",
        resolveConfig: () => ({}),
        runtime: createPluginRuntimeMock(),
      }),
    ).resolves.toMatchObject({
      status: "failed",
      code: "upstream-unavailable",
    });
    expect(forkThread).not.toHaveBeenCalled();
  });

  it("preserves a fork claimed by another session before import binding", async () => {
    boundaryMocks.listTurns
      .mockResolvedValueOnce([turn("turn-2", "edit me")])
      .mockImplementationOnce(async () => {
        await testCodexAppServerBindingStore.mutate(
          { kind: "conversation", bindingId: "competing-owner" },
          { kind: "set", binding: { threadId: "thread-forked", cwd: "/tmp" } },
        );
        return [turn("turn-1", "one")];
      });
    const { archiveThread, control, forkThread } = forkControl();

    const result = await forkCodexUpstreamSession(forkParams(), {
      bindingStore: testCodexAppServerBindingStore,
      control,
      harnessRuntimeId: "codex",
      resolveConfig: () => ({}),
      runtime: createPluginRuntimeMock(),
    });

    expect(result).toMatchObject({ status: "failed", code: "upstream-unavailable" });
    expect(forkThread).toHaveBeenCalledOnce();
    await expect(
      testCodexAppServerBindingStore.read({
        kind: "conversation",
        bindingId: "competing-owner",
      }),
    ).resolves.toMatchObject({ threadId: "thread-forked" });
    expect(linkMocks.upsert).not.toHaveBeenCalled();
    expect(archiveThread).not.toHaveBeenCalled();
  });

  it.each([
    { name: "clears a committed lost-ack binding", clearFails: false },
    { name: "preserves binding and link when compensation clear fails", clearFails: true },
  ])("$name", async ({ clearFails }) => {
    boundaryMocks.listTurns
      .mockResolvedValueOnce([turn("turn-2", "edit me")])
      .mockResolvedValueOnce([turn("turn-1", "one")]);
    const { archiveThread, control } = forkControl();
    const originalMutate = testCodexAppServerBindingStore.mutate.bind(
      testCodexAppServerBindingStore,
    );
    let targetIdentity: Parameters<CodexAppServerBindingStore["read"]>[0] | undefined;
    const bindingStore: CodexAppServerBindingStore = {
      ...testCodexAppServerBindingStore,
      mutate: async (identity, mutation) => {
        if (mutation.kind === "set" && mutation.binding.threadId === "thread-forked") {
          targetIdentity = identity;
          await originalMutate(identity, mutation);
          throw new Error("binding commit acknowledgement lost");
        }
        if (clearFails && mutation.kind === "clear" && mutation.threadId === "thread-forked") {
          return false;
        }
        return await originalMutate(identity, mutation);
      },
    };

    const result = await forkCodexUpstreamSession(forkParams(), {
      bindingStore,
      control,
      harnessRuntimeId: "codex",
      resolveConfig: () => ({}),
      runtime: createPluginRuntimeMock(),
    });

    expect(result).toMatchObject({ status: "failed", code: "upstream-unavailable" });
    if (!targetIdentity) {
      throw new Error("expected target binding identity");
    }
    if (clearFails) {
      await expect(testCodexAppServerBindingStore.read(targetIdentity)).resolves.toMatchObject({
        threadId: "thread-forked",
      });
      expect(linkMocks.delete).not.toHaveBeenCalled();
      expect(archiveThread).not.toHaveBeenCalled();
    } else {
      await expect(testCodexAppServerBindingStore.read(targetIdentity)).resolves.toBeUndefined();
      expect(linkMocks.delete).toHaveBeenCalled();
      expect(archiveThread).toHaveBeenCalledWith("thread-forked");
    }
  });
});
