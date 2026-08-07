import fs from "node:fs/promises";
import path from "node:path";
import { MODEL_SELECTION_LOCKED_MESSAGE } from "openclaw/plugin-sdk/model-session-runtime";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import { CODEX_CONTROL_METHODS } from "./app-server/capabilities.js";
import {
  readCodexAppServerBinding,
  registerCodexTestSessionIdentity,
  resetCodexTestBindingStore,
  seedCodexTestBindingForIdentity,
  seedRetiredLegacyMcpThread,
  testCodexAppServerBindingStore,
  type CodexAppServerBindingStore,
  writeCodexAppServerBinding,
} from "./app-server/session-binding.test-helpers.js";
import { createCodexThreadsTool } from "./native-thread-tool.js";

describe("native Codex thread tool legacy MCP and fork safety", () => {
  let root: string;
  let sessionFile: string;

  async function withFixture(run: () => void | Promise<void>): Promise<void> {
    await withTempDir("openclaw-codex-threads-", async (tempRoot) => {
      root = tempRoot;
      sessionFile = path.join(root, "sessions", "session-id.jsonl");
      await fs.mkdir(path.dirname(sessionFile), { recursive: true });
      await fs.writeFile(sessionFile, "");
      resetCodexTestBindingStore();
      registerCodexTestSessionIdentity(
        "session-id",
        "session-id",
        "agent:main:telegram:direct:owner",
      );
      await run();
    });
  }

  function createTool(params?: {
    owner?: boolean;
    homeScope?: "agent" | "user";
    omitHomeScope?: boolean;
    supervision?: boolean;
    allowRawTranscripts?: boolean;
    allowWriteControls?: boolean;
    getPluginConfig?: () => unknown;
    request?: ReturnType<typeof vi.fn>;
    sessionId?: string | null;
    modelSelectionLocked?: boolean;
    bindingStore?: CodexAppServerBindingStore;
  }) {
    const context: OpenClawPluginToolContext = {
      config: {},
      agentId: "main",
      agentDir: path.join(root, "agent"),
      workspaceDir: path.join(root, "workspace"),
      sessionKey: "agent:main:telegram:direct:owner",
      sessionId: params?.sessionId === null ? undefined : (params?.sessionId ?? "session-id"),
      senderIsOwner: params?.owner ?? true,
    };
    const runtime = createPluginRuntimeMock({
      agent: {
        session: {
          getSessionEntry: () => ({
            sessionId: "session-id",
            sessionFile,
            updatedAt: Date.now(),
            modelSelectionLocked: params?.modelSelectionLocked,
          }),
          resolveStorePath: () => path.join(root, "sessions", "sessions.json"),
        },
      },
    });
    return createCodexThreadsTool({
      bindingStore: params?.bindingStore ?? testCodexAppServerBindingStore,
      context,
      runtime,
      getPluginConfig:
        params?.getPluginConfig ??
        (() => ({
          ...(params?.omitHomeScope
            ? {}
            : { appServer: { homeScope: params?.homeScope ?? "user" } }),
          ...(params?.supervision
            ? {
                supervision: {
                  enabled: true,
                  ...(params.allowRawTranscripts ? { allowRawTranscripts: true } : {}),
                  ...(params.allowWriteControls ? { allowWriteControls: true } : {}),
                },
              }
            : {}),
        })),
      request: params?.request as never,
    });
  }

  function forkResponse(threadId = "forked-thread", threadOverrides: Record<string, unknown> = {}) {
    return {
      approvalPolicy: "never",
      approvalsReviewer: "user",
      cwd: "/tmp/project",
      model: "gpt-5.5",
      modelProvider: "openai",
      sandbox: { type: "dangerFullAccess" },
      thread: {
        id: threadId,
        sessionId: threadId,
        cliVersion: "0.146.1",
        createdAt: 1,
        updatedAt: 1,
        cwd: "/tmp/project",
        ephemeral: false,
        modelProvider: "openai",
        preview: "",
        source: "appServer",
        status: { type: "idle" },
        turns: [],
        ...threadOverrides,
      },
    };
  }

  it("redacts detached fork transcripts when raw reads are disabled", () =>
    withFixture(async () => {
      const request = vi.fn(async () =>
        forkResponse("forked-thread", {
          name: "Safe title",
          preview: "private preview",
          turns: [{ id: "turn-1", status: "completed", items: [] }],
        }),
      );
      const tool = createTool({
        omitHomeScope: true,
        supervision: true,
        allowWriteControls: true,
        request,
      });

      const result = await tool?.execute("call-redacted-fork", {
        action: "fork",
        thread_id: "source-thread",
        attach: false,
      });

      expect(request).toHaveBeenCalledWith(
        expect.any(Object),
        CODEX_CONTROL_METHODS.forkThread,
        { threadId: "source-thread", threadSource: "user", excludeTurns: true },
        expect.any(Object),
      );
      expect(result?.details).toMatchObject({
        action: "fork",
        sourceThreadId: "source-thread",
        thread: {
          id: "forked-thread",
          cwd: "/tmp/project",
          name: "Safe title",
          status: { type: "idle" },
        },
        attached: false,
      });
      const details = result?.details as { thread?: unknown } | undefined;
      expect(details?.thread).not.toHaveProperty("preview");
      expect(details?.thread).not.toHaveProperty("turns");
    }));

  it("redacts unarchive transcripts when raw reads are disabled", () =>
    withFixture(async () => {
      const request = vi.fn(async () => ({
        thread: {
          id: "thread-1",
          name: "Safe title",
          preview: "private preview",
          status: { type: "notLoaded" },
          turns: [{ id: "turn-1", items: [] }],
        },
      }));
      const tool = createTool({
        omitHomeScope: true,
        supervision: true,
        allowWriteControls: true,
        request,
      });

      const result = await tool?.execute("call-redacted-unarchive", {
        action: "unarchive",
        thread_id: "thread-1",
      });

      expect(request).toHaveBeenCalledWith(
        expect.any(Object),
        CODEX_CONTROL_METHODS.unarchiveThread,
        { threadId: "thread-1" },
        expect.any(Object),
      );
      expect(result?.details).toEqual({
        thread: {
          id: "thread-1",
          name: "Safe title",
          status: { type: "notLoaded" },
        },
      });
    }));

  it("rejects unarchiving a retired configured MCP predecessor", () =>
    withFixture(async () => {
      seedCodexTestBindingForIdentity(
        { kind: "conversation", bindingId: "retirement-owner" },
        {
          threadId: "thread-successor",
          cwd: "/tmp/project",
          dynamicToolsFingerprint: "dynamic-v2",
          legacyMcpRetirementThreadId: "thread-retired-mcp",
        },
      );
      await testCodexAppServerBindingStore.recordLegacyMcpThreadRetirement("thread-retired-mcp");
      const request = vi.fn();
      const tool = createTool({ request });

      await expect(
        tool?.execute("call-retired-unarchive", {
          action: "unarchive",
          thread_id: "thread-retired-mcp",
        }),
      ).rejects.toThrow("cannot be unarchived");

      expect(request).not.toHaveBeenCalled();
    }));

  it.each([
    { action: "fork", params: { action: "fork", thread_id: "thread-child", attach: false } },
    { action: "unarchive", params: { action: "unarchive", thread_id: "thread-child" } },
  ] as const)(
    "rejects $action for a descendant of retired configured MCP authority",
    ({ params }) =>
      withFixture(async () => {
        await seedRetiredLegacyMcpThread("thread-retired-root");
        const request = vi.fn(
          async (_config, method: string, requestParams: { threadId: string }) => {
            if (method !== CODEX_CONTROL_METHODS.readThread) {
              throw new Error(`unexpected method: ${method}`);
            }
            return {
              thread: {
                id: requestParams.threadId,
                parentThreadId: "thread-retired-root",
                status: { type: "idle" },
              },
            };
          },
        );
        const tool = createTool({ request });

        await expect(tool?.execute("call-retired-descendant", params)).rejects.toThrow(
          "descends from retired configured MCP authority",
        );
        expect(request.mock.calls.map(([, method]) => method)).toEqual([
          CODEX_CONTROL_METHODS.readThread,
        ]);
      }),
  );

  it("allows explicit archive cleanup of a retired configured MCP predecessor", () =>
    withFixture(async () => {
      await seedRetiredLegacyMcpThread("thread-retired-root");
      const request = vi.fn(async (_config, method: string) => {
        if (method === CODEX_CONTROL_METHODS.readThread) {
          return { thread: { id: "thread-retired-root", status: { type: "idle" } } };
        }
        if (method === CODEX_CONTROL_METHODS.listThreads) {
          return { data: [], nextCursor: null };
        }
        if (method === CODEX_CONTROL_METHODS.archiveThread) {
          return {};
        }
        throw new Error(`unexpected method: ${method}`);
      });
      const tool = createTool({ request });

      await expect(
        tool?.execute("call-retired-archive", {
          action: "archive",
          thread_id: "thread-retired-root",
          confirm: true,
        }),
      ).resolves.toMatchObject({ details: { action: "archive", threadId: "thread-retired-root" } });
      expect(request.mock.calls.map(([, method]) => method)).toEqual([
        CODEX_CONTROL_METHODS.readThread,
        CODEX_CONTROL_METHODS.listThreads,
        CODEX_CONTROL_METHODS.archiveThread,
      ]);
    }));

  it("forks a native thread and attaches the fork to the OpenClaw session", () =>
    withFixture(async () => {
      const request = vi.fn(async (_config, method: string) =>
        method === CODEX_CONTROL_METHODS.readThread
          ? { thread: { id: "source-thread", status: { type: "notLoaded" } } }
          : forkResponse(),
      );
      const tool = createTool({ request, sessionId: null });

      const result = await tool?.execute("call-2", {
        action: "fork",
        thread_id: "source-thread",
      });

      expect(request).toHaveBeenNthCalledWith(
        1,
        { appServer: { homeScope: "user" } },
        CODEX_CONTROL_METHODS.readThread,
        { threadId: "source-thread", includeTurns: false },
        expect.any(Object),
      );
      expect(request).toHaveBeenNthCalledWith(
        2,
        { appServer: { homeScope: "user" } },
        CODEX_CONTROL_METHODS.forkThread,
        { threadId: "source-thread", threadSource: "user", excludeTurns: true },
        expect.any(Object),
      );
      await expect(
        readCodexAppServerBinding("session-id", { agentDir: path.join(root, "agent") }),
      ).resolves.toMatchObject({
        threadId: "forked-thread",
        cwd: "/tmp/project",
        model: "gpt-5.5",
        modelProvider: "openai",
        historyCoveredThrough: expect.any(String),
      });
      expect(result?.details).toMatchObject({
        action: "fork",
        sourceThreadId: "source-thread",
        attached: true,
      });
    }));

  it.each([
    { name: "attached", attach: true },
    { name: "detached", attach: false },
  ])("rejects a $name fork of a legacy configured MCP thread", ({ attach }) =>
    withFixture(async () => {
      await writeCodexAppServerBinding("session-id", {
        threadId: "source-thread",
        cwd: "/tmp/project",
        userMcpServersFingerprint: "legacy-mcp",
      });
      const request = vi.fn();
      const tool = createTool({ request });

      await expect(
        tool?.execute("call-legacy-fork", {
          action: "fork",
          thread_id: "source-thread",
          attach,
        }),
      ).rejects.toThrow("must complete its configured MCP upgrade");

      expect(request).not.toHaveBeenCalled();
    }),
  );

  it.each([
    ["user MCP", { userMcpServersFingerprint: "legacy-user-mcp" }],
    ["bundled MCP", { mcpServersFingerprint: "legacy-bundled-mcp" }],
    ["pending retirement", { legacyMcpRetirementThreadId: "thread-predecessor" }],
  ] as const)(
    "rejects archiving a bound %s thread before provenance can be cleared",
    (_name, legacy) =>
      withFixture(async () => {
        await writeCodexAppServerBinding("session-id", {
          threadId: "thread-legacy",
          cwd: "/tmp/project",
          ...legacy,
        });
        const request = vi.fn();

        await expect(
          createTool({ request })?.execute("call-legacy-archive", {
            action: "archive",
            thread_id: "thread-legacy",
            confirm: true,
          }),
        ).rejects.toThrow("configured MCP upgrade");
        expect(request).not.toHaveBeenCalled();
        await expect(readCodexAppServerBinding("session-id")).resolves.toMatchObject({
          threadId: "thread-legacy",
          ...legacy,
        });
      }),
  );

  it("rejects replacing a different legacy binding with an attached fork", () =>
    withFixture(async () => {
      await writeCodexAppServerBinding("session-id", {
        threadId: "thread-legacy",
        cwd: "/tmp/project",
        userMcpServersFingerprint: "legacy-mcp",
      });
      const request = vi.fn();
      const tool = createTool({ request });

      await expect(
        tool?.execute("call-replace-legacy-fork", {
          action: "fork",
          thread_id: "source-thread",
          attach: true,
        }),
      ).rejects.toThrow("current Codex session must complete its configured MCP upgrade");

      expect(request).not.toHaveBeenCalled();
      await expect(readCodexAppServerBinding("session-id")).resolves.toMatchObject({
        threadId: "thread-legacy",
        userMcpServersFingerprint: "legacy-mcp",
      });
    }));

  it("rejects a detached fork when another binding owns the legacy source", () =>
    withFixture(async () => {
      seedCodexTestBindingForIdentity(
        { kind: "conversation", bindingId: "other-conversation" },
        {
          threadId: "source-thread",
          cwd: "/tmp/project",
          mcpServersFingerprint: "legacy-mcp",
        },
      );
      const request = vi.fn();
      const tool = createTool({ request });

      await expect(
        tool?.execute("call-other-legacy-fork", {
          action: "fork",
          thread_id: "source-thread",
          attach: false,
        }),
      ).rejects.toThrow("owned by another OpenClaw session");

      expect(request).not.toHaveBeenCalled();
    }));

  it.each([
    { name: "attached", attach: true },
    { name: "detached", attach: false },
  ])("rejects a $name fork owned by another OpenClaw session", ({ attach }) =>
    withFixture(async () => {
      await testCodexAppServerBindingStore.mutate(
        { kind: "conversation", bindingId: "other-conversation" },
        {
          kind: "set",
          binding: { threadId: "source-thread", cwd: "/tmp/project" },
        },
      );
      const request = vi.fn();
      const tool = createTool({ request });

      await expect(
        tool?.execute("call-other-owner-fork", {
          action: "fork",
          thread_id: "source-thread",
          attach,
        }),
      ).rejects.toThrow("owned by another OpenClaw session");

      expect(request).not.toHaveBeenCalled();
    }),
  );

  it.each([
    {
      name: "a different thread id",
      response: { thread: { id: "different-thread", status: { type: "idle" } } },
      error: "returned a different thread than requested",
    },
    {
      name: "a malformed response",
      response: { thread: null },
      error: "returned an invalid thread/read response",
    },
    {
      name: "an unknown status",
      response: { thread: { id: "source-thread", status: { type: "futureStatus" } } },
      error: "unless it is idle or not loaded",
    },
    {
      name: "a missing status",
      response: { thread: { id: "source-thread" } },
      error: "unless it is idle or not loaded",
    },
    {
      name: "a system-error status",
      response: { thread: { id: "source-thread", status: { type: "systemError" } } },
      error: "unless it is idle or not loaded",
    },
    {
      name: "an active status",
      response: { thread: { id: "source-thread", status: { type: "active" } } },
      error: "unless it is idle or not loaded",
    },
  ])("refuses to attach a fork of the bound thread after $name", ({ response, error }) =>
    withFixture(async () => {
      await writeCodexAppServerBinding("session-id", {
        threadId: "source-thread",
        cwd: "/tmp/project",
      });
      const request = vi.fn(async () => response);
      const tool = createTool({ request });

      await expect(
        tool?.execute("call-unsafe-fork", {
          action: "fork",
          thread_id: "source-thread",
        }),
      ).rejects.toThrow(error);
      expect(request).toHaveBeenCalledOnce();
      expect(request).toHaveBeenCalledWith(
        expect.anything(),
        CODEX_CONTROL_METHODS.readThread,
        { threadId: "source-thread", includeTurns: false },
        expect.anything(),
      );
      expect(request).not.toHaveBeenCalledWith(
        expect.anything(),
        CODEX_CONTROL_METHODS.forkThread,
        expect.anything(),
        expect.anything(),
      );
    }),
  );

  it("reports a conflict when a fork cannot attach to the current generation", () =>
    withFixture(async () => {
      const request = vi.fn(async (_config, method: string) =>
        method === CODEX_CONTROL_METHODS.readThread
          ? { thread: { id: "source-thread", status: { type: "idle" } } }
          : method === CODEX_CONTROL_METHODS.listThreads
            ? { data: [], nextCursor: null }
            : forkResponse(),
      );
      const mutate = vi
        .spyOn(testCodexAppServerBindingStore, "mutate")
        .mockResolvedValueOnce(false);
      try {
        await expect(
          createTool({ request })?.execute("call-conflict", {
            action: "fork",
            thread_id: "source-thread",
          }),
        ).rejects.toThrow("binding changed before the fork could be attached");
      } finally {
        mutate.mockRestore();
      }
      expect(request).toHaveBeenCalledWith(
        expect.anything(),
        CODEX_CONTROL_METHODS.deleteThread,
        { threadId: "forked-thread" },
        expect.anything(),
      );
    }));

  it("preserves a failed attached fork that already has a spawned descendant", () =>
    withFixture(async () => {
      const request = vi.fn(async (_config, method: string) => {
        if (method === CODEX_CONTROL_METHODS.readThread) {
          return { thread: { id: "source-thread", status: { type: "idle" } } };
        }
        if (method === CODEX_CONTROL_METHODS.listThreads) {
          return { data: [{ id: "fork-descendant" }], nextCursor: null };
        }
        return forkResponse();
      });
      const mutate = vi
        .spyOn(testCodexAppServerBindingStore, "mutate")
        .mockResolvedValueOnce(false);
      try {
        await expect(
          createTool({ request })?.execute("call-conflict-descendant", {
            action: "fork",
            thread_id: "source-thread",
          }),
        ).rejects.toThrow("could not be cleaned up safely");
      } finally {
        mutate.mockRestore();
      }
      expect(request).not.toHaveBeenCalledWith(
        expect.anything(),
        CODEX_CONTROL_METHODS.deleteThread,
        expect.anything(),
        expect.anything(),
      );
    }));

  it("rejects a fork response that reuses the source thread without deleting it", () =>
    withFixture(async () => {
      const request = vi.fn(async (_config, method: string) =>
        method === CODEX_CONTROL_METHODS.readThread
          ? { thread: { id: "source-thread", status: { type: "idle" } } }
          : forkResponse("source-thread"),
      );
      const tool = createTool({ request });

      await expect(
        tool?.execute("call-source-reuse", {
          action: "fork",
          thread_id: "source-thread",
        }),
      ).rejects.toThrow("reused the source thread id");

      expect(request.mock.calls.map(([, method]) => method)).toEqual([
        CODEX_CONTROL_METHODS.readThread,
        CODEX_CONTROL_METHODS.forkThread,
      ]);
    }));

  it("does not trust or delete an orphan id from a malformed fork response", () =>
    withFixture(async () => {
      const request = vi.fn(async (_config, method: string) => {
        if (method === CODEX_CONTROL_METHODS.readThread) {
          return { thread: { id: "source-thread", status: { type: "idle" } } };
        }
        if (method === CODEX_CONTROL_METHODS.forkThread) {
          return { thread: { id: "thread-orphan" } };
        }
        if (method === CODEX_CONTROL_METHODS.deleteThread) {
          throw new Error("untrusted orphan id must not be deleted");
        }
        throw new Error(`unexpected method: ${method}`);
      });
      const tool = createTool({ request });

      await expect(
        tool?.execute("call-malformed-fork", {
          action: "fork",
          thread_id: "source-thread",
        }),
      ).rejects.toThrow("thread/fork response");

      expect(request).not.toHaveBeenCalledWith(
        expect.anything(),
        CODEX_CONTROL_METHODS.deleteThread,
        { threadId: "thread-orphan" },
        expect.anything(),
      );
    }));

  it("does not replace a locked session binding with an attached fork", () =>
    withFixture(async () => {
      await writeCodexAppServerBinding("session-id", {
        threadId: "bound-thread",
        cwd: "/tmp/project",
      });
      const request = vi.fn(async () => ({
        thread: { id: "forked-thread", cwd: "/tmp/project", status: { type: "idle" } },
      }));
      const tool = createTool({ request, modelSelectionLocked: true });

      await expect(
        tool?.execute("call-locked-fork", {
          action: "fork",
          thread_id: "source-thread",
        }),
      ).rejects.toThrow(MODEL_SELECTION_LOCKED_MESSAGE);

      expect(request).not.toHaveBeenCalled();
      await expect(readCodexAppServerBinding("session-id")).resolves.toMatchObject({
        threadId: "bound-thread",
      });
    }));

  it("keeps an attached fork off a private supervision connection", () =>
    withFixture(async () => {
      await writeCodexAppServerBinding("session-id", {
        threadId: "bound-thread",
        connectionScope: "supervision",
        supervisionSourceThreadId: "source-thread",
        cwd: "/tmp/project",
        model: "gpt-5.5",
        modelProvider: "openai",
        preserveNativeModel: true,
        conversationSourceTransferComplete: true,
        historyCoveredThrough: new Date().toISOString(),
      });
      const request = vi.fn(async () => ({
        thread: { id: "forked-thread", cwd: "/tmp/project", status: { type: "idle" } },
      }));
      const tool = createTool({
        omitHomeScope: true,
        supervision: true,
        allowWriteControls: true,
        request,
      });

      await expect(
        tool?.execute("call-supervised-fork", {
          action: "fork",
          thread_id: "source-thread",
        }),
      ).rejects.toThrow("Supervised Codex forks must stay detached");

      expect(request).not.toHaveBeenCalled();
    }));

  it("keeps an attached fork off a supervision-only connection without a binding", () =>
    withFixture(async () => {
      const request = vi.fn();
      const tool = createTool({
        omitHomeScope: true,
        supervision: true,
        allowWriteControls: true,
        request,
      });

      await expect(
        tool?.execute("call-supervision-only-fork", {
          action: "fork",
          thread_id: "source-thread",
        }),
      ).rejects.toThrow("Supervised Codex forks must stay detached");
      expect(request).not.toHaveBeenCalled();
      await expect(readCodexAppServerBinding("session-id")).resolves.toBeUndefined();
    }));

  it("rechecks the live connection config before attaching a fork", () =>
    withFixture(async () => {
      let pluginConfig: unknown = { appServer: { homeScope: "user" } };
      const request = vi.fn();
      const tool = createTool({ request, getPluginConfig: () => pluginConfig });
      pluginConfig = { supervision: { enabled: true, allowWriteControls: true } };

      await expect(
        tool?.execute("call-live-supervision-fork", {
          action: "fork",
          thread_id: "source-thread",
        }),
      ).rejects.toThrow("Supervised Codex forks must stay detached");
      expect(request).not.toHaveBeenCalled();
    }));

  it("allows a detached fork through a supervision-only connection", () =>
    withFixture(async () => {
      const response = forkResponse();
      const request = vi.fn(async () => response);
      const tool = createTool({
        omitHomeScope: true,
        supervision: true,
        allowWriteControls: true,
        request,
      });

      const result = await tool?.execute("call-supervision-detached-fork", {
        action: "fork",
        thread_id: "source-thread",
        attach: false,
      });

      expect(result?.details).toMatchObject({ attached: false });
      await expect(readCodexAppServerBinding("session-id")).resolves.toBeUndefined();
    }));

  it("allows a detached fork without changing a locked session binding", () =>
    withFixture(async () => {
      await writeCodexAppServerBinding("session-id", {
        threadId: "bound-thread",
        cwd: "/tmp/project",
      });
      const request = vi.fn(async () => forkResponse());
      const tool = createTool({ request, modelSelectionLocked: true });

      const result = await tool?.execute("call-detached-fork", {
        action: "fork",
        thread_id: "source-thread",
        attach: false,
      });

      expect(request).toHaveBeenCalledWith(
        { appServer: { homeScope: "user" } },
        CODEX_CONTROL_METHODS.forkThread,
        { threadId: "source-thread", threadSource: "user", excludeTurns: true },
        expect.any(Object),
      );
      expect(result?.details).toMatchObject({ attached: false });
      await expect(readCodexAppServerBinding("session-id")).resolves.toMatchObject({
        threadId: "bound-thread",
      });
    }));
});
