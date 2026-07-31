import type { AgentSideConnection, SessionUpdate } from "@agentclientprotocol/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emitAgentEvent, resetAgentEventsForTest } from "../infra/agent-events.js";
import { createInMemoryAcpEventLedger } from "./event-ledger.js";
import type { AcpLocalSessionRuntime } from "./local-session-runtime.js";
import { AcpLocalTurnRuntime, type AcpLocalTurnSession } from "./local-turn-runtime.js";
import { AcpTranslatorSessionUpdates } from "./translator.session-updates.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createSessionRuntime(): AcpLocalSessionRuntime {
  const snapshot = {
    configOptions: [],
    modes: {
      currentModeId: "adaptive",
      availableModes: [{ id: "adaptive", name: "Adaptive" }],
    },
  };
  return {
    resolveSessionKey: async ({ fallbackKey }) => fallbackKey,
    resetSessionIfNeeded: async () => {},
    getSessionSnapshot: async () => snapshot,
    getExistingSessionSnapshot: async () => snapshot,
    patchSession: async () => snapshot,
    listSessions: async () => [],
    getSessionTranscript: async () => [],
  };
}

function createHarness(
  executeAgent: (...args: never[]) => Promise<unknown>,
  options: {
    prefixCwd?: boolean;
    provenanceMode?: "off" | "meta" | "meta+receipt";
    sessionRuntime?: AcpLocalSessionRuntime;
    sessionUpdate?: AgentSideConnection["sessionUpdate"];
  } = {},
) {
  const updates: Array<{ sessionId: string; update: SessionUpdate }> = [];
  const connection = {
    requestPermission: vi.fn(),
    sessionUpdate:
      options.sessionUpdate ??
      vi.fn(async (params: { sessionId: string; update: SessionUpdate }) => {
        updates.push(params);
      }),
  } as unknown as AgentSideConnection;
  const sessionRuntime = options.sessionRuntime ?? createSessionRuntime();
  const sessionUpdates = new AcpTranslatorSessionUpdates({
    connection,
    eventLedger: createInMemoryAcpEventLedger(),
    getAvailableCommands: async () => [],
    log: () => {},
  });
  let runSequence = 0;
  const runtime = new AcpLocalTurnRuntime({
    connection,
    sessionRuntime,
    sessionUpdates,
    executeAgent: executeAgent as never,
    createRunId: () => `run-${++runSequence}`,
    prefixCwd: options.prefixCwd,
    provenanceMode: options.provenanceMode,
  });
  const session: AcpLocalTurnSession = {
    sessionId: "session-1",
    sessionKey: "agent:main:session-1",
    cwd: "/tmp/acp-project",
  };
  return { connection, runtime, session, sessionUpdates, updates };
}

function prompt(runtime: AcpLocalTurnRuntime, session: AcpLocalTurnSession, text = "hello") {
  return runtime.prompt(session, {
    sessionId: session.sessionId,
    prompt: [{ type: "text", text }],
  });
}

afterEach(() => {
  resetAgentEventsForTest();
  delete process.env.BUZZ_PRIVATE_KEY;
});

describe("AcpLocalTurnRuntime", () => {
  it("executes in-process with inherited environment and local-run policy", async () => {
    process.env.BUZZ_PRIVATE_KEY = "test-only-buzz-key";
    let observedBuzzKey: string | undefined;
    const executeAgent = vi.fn(async (opts: { runId: string }) => {
      observedBuzzKey = process.env.BUZZ_PRIVATE_KEY;
      emitAgentEvent({
        runId: opts.runId,
        stream: "assistant",
        data: { delta: "from local tools" },
      });
      return { payloads: [{ text: "from local tools" }], meta: {} };
    });
    const { runtime, session, updates } = createHarness(executeAgent);

    await expect(prompt(runtime, session)).resolves.toEqual({ stopReason: "end_turn" });

    expect(observedBuzzKey).toBe("test-only-buzz-key");
    expect(executeAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:session-1",
        approvalHost: expect.any(Object),
        senderIsOwner: true,
        allowModelOverride: false,
        deliver: false,
      }),
      expect.any(Object),
    );
    expect(updates).toContainEqual({
      sessionId: "session-1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "from local tools" },
      },
    });
    expect(runtime.activeRunCount()).toBe(0);
  });

  it("ignores client delivery metadata for protocol-only prompts", async () => {
    const executeAgent = vi.fn(async (opts: { runId: string }) => {
      emitAgentEvent({
        runId: opts.runId,
        stream: "assistant",
        data: { delta: "protocol reply" },
      });
      return { payloads: [{ text: "protocol reply" }], meta: {} };
    });
    const { runtime, session, updates } = createHarness(executeAgent);

    await expect(
      runtime.prompt(session, {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "hello" }],
        _meta: { deliver: true },
      }),
    ).resolves.toEqual({ stopReason: "end_turn" });

    expect(executeAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        deliver: false,
        channel: "webchat",
        runContext: {
          messageChannel: "webchat",
          currentChannelId: "webchat",
        },
      }),
      expect.any(Object),
    );
    expect(updates).toContainEqual({
      sessionId: "session-1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "protocol reply" },
      },
    });
  });

  it("passes prompt text, images, cwd, runtime options, and provenance", async () => {
    const executeAgent = vi.fn(async () => ({ payloads: [], meta: {} }));
    const { runtime, session } = createHarness(executeAgent, {
      provenanceMode: "meta+receipt",
    });
    session.runtimeOptions = {
      thinking: "high",
      timeoutSeconds: 12,
      backendExtras: { verbose: "full", fastMode: "true" },
    };

    await runtime.prompt(session, {
      sessionId: session.sessionId,
      prompt: [
        { type: "text", text: "inspect this" },
        {
          type: "resource",
          resource: { uri: "file:///tmp/spec.txt", text: "spec contents" },
        },
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
      ],
    });

    expect(executeAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("[Source Receipt]"),
        transcriptMessage: expect.stringContaining("inspect this"),
        images: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
        cwd: "/tmp/acp-project",
        thinking: "high",
        verbose: "full",
        fastMode: true,
        timeout: "12",
        inputProvenance: {
          kind: "external_user",
          sourceChannel: "acp",
        },
      }),
      expect.any(Object),
    );
    const message = (executeAgent.mock.calls[0]?.[0] as { message?: string } | undefined)?.message;
    expect(message).toContain("targetSession=agent:main:session-1");
    expect(message).toContain("spec contents");
  });

  it("rejects oversized prompts before execution", async () => {
    const executeAgent = vi.fn(async () => ({ payloads: [], meta: {} }));
    const { runtime, session } = createHarness(executeAgent, { prefixCwd: false });

    await expect(
      runtime.prompt(session, {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "x".repeat(2 * 1024 * 1024 + 1) }],
      }),
    ).rejects.toThrow("Prompt exceeds maximum allowed size");
    expect(executeAgent).not.toHaveBeenCalled();
  });

  it("includes decoded image bytes in the aggregate prompt limit", async () => {
    const executeAgent = vi.fn(async () => ({ payloads: [], meta: {} }));
    const { runtime, session } = createHarness(executeAgent, { prefixCwd: false });

    await expect(
      runtime.prompt(session, {
        sessionId: session.sessionId,
        prompt: [
          {
            type: "image",
            data: Buffer.alloc(2 * 1024 * 1024 + 1).toString("base64"),
            mimeType: "image/png",
          },
        ],
      }),
    ).rejects.toThrow("Prompt exceeds maximum allowed size");
    expect(executeAgent).not.toHaveBeenCalled();
  });

  it("omits agent provenance metadata when provenance is off", async () => {
    const executeAgent = vi.fn(async () => ({ payloads: [], meta: {} }));
    const { runtime, session } = createHarness(executeAgent, { provenanceMode: "off" });

    await prompt(runtime, session);

    expect(executeAgent.mock.calls[0]?.[0]).not.toHaveProperty("inputProvenance");
  });

  it("projects assistant, thought, and tool events without duplicating the final payload", async () => {
    const executeAgent = vi.fn(async (opts: { runId: string }) => {
      emitAgentEvent({
        runId: opts.runId,
        stream: "thinking",
        data: { delta: "considering" },
      });
      emitAgentEvent({
        runId: opts.runId,
        stream: "assistant",
        data: { delta: "  answer" },
      });
      emitAgentEvent({
        runId: opts.runId,
        stream: "tool",
        data: {
          phase: "start",
          toolCallId: "tool-1",
          name: "read",
          args: { path: "/tmp/acp-project/file.txt" },
        },
      });
      emitAgentEvent({
        runId: opts.runId,
        stream: "tool",
        data: {
          phase: "result",
          toolCallId: "tool-1",
          result: "file contents",
        },
      });
      return { payloads: [{ text: "  answer" }], meta: {} };
    });
    const { runtime, session, updates } = createHarness(executeAgent);

    await prompt(runtime, session);

    expect(updates.map((entry) => entry.update.sessionUpdate)).toEqual(
      expect.arrayContaining([
        "agent_thought_chunk",
        "agent_message_chunk",
        "tool_call",
        "tool_call_update",
      ]),
    );
    expect(updates.filter((entry) => entry.update.sessionUpdate === "agent_message_chunk")).toEqual(
      [
        {
          sessionId: "session-1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "  answer" },
          },
        },
      ],
    );
    expect(
      updates.find((entry) => entry.update.sessionUpdate === "tool_call")?.update,
    ).toMatchObject({
      toolCallId: "tool-1",
      status: "in_progress",
      locations: [{ path: "/tmp/acp-project/file.txt" }],
    });
  });

  it("separates streamed assistant blocks without replaying final payloads", async () => {
    const executeAgent = vi.fn(
      async (opts: { runId: string; onAssistantMessageStart?: () => void }) => {
        opts.onAssistantMessageStart?.();
        emitAgentEvent({
          runId: opts.runId,
          stream: "assistant",
          data: { text: "one" },
        });
        opts.onAssistantMessageStart?.();
        emitAgentEvent({
          runId: opts.runId,
          stream: "assistant",
          data: { text: "two" },
        });
        return {
          payloads: [{ text: "hidden", isReasoning: true }, { text: "one" }, { text: "two" }],
          meta: {},
        };
      },
    );
    const { runtime, session, updates } = createHarness(executeAgent);

    await prompt(runtime, session);

    const chunks = updates
      .filter((entry) => entry.update.sessionUpdate === "agent_message_chunk")
      .map((entry) =>
        entry.update.sessionUpdate === "agent_message_chunk" && entry.update.content.type === "text"
          ? entry.update.content.text
          : "",
      );
    expect(chunks).toEqual(["one", "\n\ntwo"]);
    expect(chunks.join("")).toBe("one\n\ntwo");
  });

  it("keeps replacement snapshots in the current assistant block", async () => {
    const executeAgent = vi.fn(
      async (opts: { runId: string; onAssistantMessageStart?: () => void }) => {
        opts.onAssistantMessageStart?.();
        emitAgentEvent({
          runId: opts.runId,
          stream: "assistant",
          data: { text: "draft" },
        });
        emitAgentEvent({
          runId: opts.runId,
          stream: "assistant",
          data: { text: "draft revised", replace: true },
        });
        return { payloads: [{ text: "draft revised" }], meta: {} };
      },
    );
    const { runtime, session, updates } = createHarness(executeAgent);

    await prompt(runtime, session);

    const chunks = updates
      .filter((entry) => entry.update.sessionUpdate === "agent_message_chunk")
      .map((entry) =>
        entry.update.sessionUpdate === "agent_message_chunk" && entry.update.content.type === "text"
          ? entry.update.content.text
          : "",
      );
    expect(chunks).toEqual(["draft", " revised"]);
    expect(chunks.join("")).toBe("draft revised");
  });

  it("separates non-streamed final payload blocks", async () => {
    const executeAgent = vi.fn(async () => ({
      payloads: [{ text: "hidden", isReasoning: true }, { text: "one" }, { text: "two" }],
      meta: {},
    }));
    const { runtime, session, updates } = createHarness(executeAgent);

    await prompt(runtime, session);

    const chunks = updates
      .filter((entry) => entry.update.sessionUpdate === "agent_message_chunk")
      .map((entry) =>
        entry.update.sessionUpdate === "agent_message_chunk" && entry.update.content.type === "text"
          ? entry.update.content.text
          : "",
    );
    expect(chunks).toEqual(["one\n\ntwo"]);
    expect(chunks.join("")).toBe("one\n\ntwo");
  });

  it("rejects an invalid concurrent prompt without cancelling active work", async () => {
    const release = deferred<void>();
    let observedAbort = false;
    const executeAgent = vi.fn(async (opts: { abortSignal: AbortSignal }) => {
      opts.abortSignal.addEventListener(
        "abort",
        () => {
          observedAbort = true;
        },
        { once: true },
      );
      await release.promise;
      return { payloads: [], meta: {} };
    });
    const { runtime, session } = createHarness(executeAgent, { prefixCwd: false });
    const active = prompt(runtime, session, "valid");
    await vi.waitFor(() => expect(runtime.activeRunCount()).toBe(1));

    await expect(
      runtime.prompt(session, {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "x".repeat(2 * 1024 * 1024 + 1) }],
      }),
    ).rejects.toThrow("Prompt exceeds maximum allowed size");
    expect(observedAbort).toBe(false);
    expect(runtime.activeRunCount()).toBe(1);

    release.resolve();
    await expect(active).resolves.toEqual({ stopReason: "end_turn" });
  });

  it("serializes prompt supersession with final assistant projection", async () => {
    const finalDeliveryStarted = deferred<void>();
    const releaseFinalDelivery = deferred<void>();
    const updates: SessionUpdate[] = [];
    let executionCount = 0;
    const executeAgent = vi.fn(async () => {
      executionCount += 1;
      return { payloads: [{ text: executionCount === 1 ? "first" : "second" }], meta: {} };
    });
    const harness = createHarness(executeAgent, {
      sessionUpdate: vi.fn(async ({ update }: { update: SessionUpdate }) => {
        if (update.sessionUpdate === "agent_message_chunk" && update.content.text === "first") {
          finalDeliveryStarted.resolve();
          await releaseFinalDelivery.promise;
        }
        updates.push(update);
      }),
    });

    const first = prompt(harness.runtime, harness.session, "first prompt");
    await finalDeliveryStarted.promise;
    const second = prompt(harness.runtime, harness.session, "second prompt");
    await Promise.resolve();
    expect(executeAgent).toHaveBeenCalledTimes(1);

    releaseFinalDelivery.resolve();
    await expect(first).resolves.toEqual({ stopReason: "end_turn" });
    await expect(second).resolves.toEqual({ stopReason: "end_turn" });
    expect(
      updates
        .filter((update) => update.sessionUpdate === "agent_message_chunk")
        .map((update) => update.content.text),
    ).toEqual(["first", "second"]);
  });

  it("aborts promptly when cancellation arrives during final projection", async () => {
    const finalDeliveryStarted = deferred<void>();
    const releaseFinalDelivery = deferred<void>();
    const updates: SessionUpdate[] = [];
    const sessionRuntime = {
      ...createSessionRuntime(),
      getSessionSnapshot: vi.fn(async () => ({
        configOptions: [],
        modes: {
          currentModeId: "adaptive",
          availableModes: [{ id: "adaptive", name: "Adaptive" }],
        },
        metadata: {
          title: "Cancelled",
          updatedAt: "2026-07-31T00:00:00.000Z",
          _meta: { sessionKey: "agent:main:session-1", kind: "direct" },
        },
        usage: { used: 10, size: 100 },
      })),
    };
    const harness = createHarness(
      vi.fn(async () => ({ payloads: [{ text: "late answer" }], meta: {} })),
      {
        sessionRuntime,
        sessionUpdate: vi.fn(async ({ update }: { update: SessionUpdate }) => {
          updates.push(update);
          if (update.sessionUpdate === "agent_message_chunk") {
            finalDeliveryStarted.resolve();
            await releaseFinalDelivery.promise;
          }
        }),
      },
    );

    const response = prompt(harness.runtime, harness.session);
    await finalDeliveryStarted.promise;
    await expect(harness.runtime.cancel(harness.session.sessionId)).resolves.toBeUndefined();

    releaseFinalDelivery.resolve();
    await expect(response).resolves.toEqual({ stopReason: "cancelled" });
    expect(sessionRuntime.getSessionSnapshot).not.toHaveBeenCalled();
    expect(updates.map((update) => update.sessionUpdate)).toEqual(["agent_message_chunk"]);
  });

  it.each(["max_tokens", "max_turn_requests", "refusal"] as const)(
    "preserves the %s stop reason",
    async (stopReason) => {
      const { runtime, session } = createHarness(
        vi.fn(async () => ({ payloads: [], meta: { stopReason } })),
      );
      await expect(prompt(runtime, session)).resolves.toEqual({ stopReason });
    },
  );

  it("cancels the exact local turn and isolates concurrent sessions", async () => {
    const gates = new Map([
      ["agent:main:session-1", deferred<void>()],
      ["agent:main:session-2", deferred<void>()],
    ]);
    const executeAgent = vi.fn(
      async (opts: { sessionKey: string; abortSignal: AbortSignal }) =>
        await new Promise<{ payloads: never[]; meta: { aborted?: true } }>((resolve) => {
          opts.abortSignal.addEventListener(
            "abort",
            () => resolve({ payloads: [], meta: { aborted: true } }),
            { once: true },
          );
          void gates.get(opts.sessionKey)?.promise.then(() => resolve({ payloads: [], meta: {} }));
        }),
    );
    const { runtime, session } = createHarness(executeAgent);
    const second = {
      ...session,
      sessionId: "session-2",
      sessionKey: "agent:main:session-2",
    };

    const firstResult = prompt(runtime, session);
    const secondResult = prompt(runtime, second);
    await vi.waitFor(() => expect(runtime.activeRunCount()).toBe(2));

    await runtime.cancel(session.sessionId);
    await expect(firstResult).resolves.toEqual({ stopReason: "cancelled" });
    expect(runtime.activeRunCount()).toBe(1);

    gates.get(second.sessionKey)?.resolve();
    await expect(secondResult).resolves.toEqual({ stopReason: "end_turn" });
    expect(runtime.activeRunCount()).toBe(0);
  });

  it("fails open tool calls when a turn is cancelled", async () => {
    const executeAgent = vi.fn(
      async (opts: { runId: string; abortSignal: AbortSignal }) =>
        await new Promise<{ payloads: never[]; meta: { aborted: true } }>((resolve) => {
          emitAgentEvent({
            runId: opts.runId,
            stream: "tool",
            data: {
              phase: "start",
              toolCallId: "tool-cancelled",
              name: "exec",
              args: { command: "sleep 30" },
            },
          });
          opts.abortSignal.addEventListener(
            "abort",
            () => resolve({ payloads: [], meta: { aborted: true } }),
            { once: true },
          );
        }),
    );
    const { runtime, session, updates } = createHarness(executeAgent);
    const response = prompt(runtime, session);
    await vi.waitFor(() =>
      expect(
        updates.some(
          (entry) =>
            entry.update.sessionUpdate === "tool_call" &&
            entry.update.toolCallId === "tool-cancelled",
        ),
      ).toBe(true),
    );

    await runtime.cancel(session.sessionId);
    await expect(response).resolves.toEqual({ stopReason: "cancelled" });
    expect(updates.at(-1)?.update).toMatchObject({
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-cancelled",
      status: "failed",
      rawOutput: "Turn cancelled.",
    });
  });

  it("fails open tool calls when execution throws or omits a result", async () => {
    const failed = createHarness(
      vi.fn(async (opts: { runId: string }) => {
        emitAgentEvent({
          runId: opts.runId,
          stream: "tool",
          data: {
            phase: "start",
            toolCallId: "tool-failed",
            name: "exec",
            args: { command: "false" },
          },
        });
        throw new Error("model failed");
      }),
    );

    await expect(prompt(failed.runtime, failed.session)).rejects.toThrow("model failed");
    expect(failed.updates.at(-1)?.update).toMatchObject({
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-failed",
      status: "failed",
      rawOutput: "Turn execution failed.",
    });

    const incomplete = createHarness(
      vi.fn(async (opts: { runId: string }) => {
        emitAgentEvent({
          runId: opts.runId,
          stream: "tool",
          data: {
            phase: "start",
            toolCallId: "tool-incomplete",
            name: "read",
            args: { path: "/tmp/incomplete" },
          },
        });
        return { payloads: [], meta: {} };
      }),
    );

    await expect(prompt(incomplete.runtime, incomplete.session)).resolves.toEqual({
      stopReason: "end_turn",
    });
    expect(
      incomplete.updates.find(
        (entry) =>
          entry.update.sessionUpdate === "tool_call_update" &&
          entry.update.toolCallId === "tool-incomplete",
      )?.update,
    ).toMatchObject({
      status: "failed",
      rawOutput: "Tool call ended without reporting a result.",
    });
  });

  it("lets only the newest prompt pass a delayed setup boundary", async () => {
    const baseLedger = createInMemoryAcpEventLedger();
    const firstPromptGate = deferred<void>();
    let promptCount = 0;
    const eventLedger = {
      ...baseLedger,
      recordUserPrompt: async (
        params: Parameters<typeof baseLedger.recordUserPrompt>[0],
      ): Promise<void> => {
        promptCount += 1;
        if (promptCount === 1) {
          await firstPromptGate.promise;
        }
        await baseLedger.recordUserPrompt(params);
      },
    };
    const executeAgent = vi.fn(async () => ({ payloads: [], meta: {} }));
    const harness = createHarness(executeAgent);
    harness.sessionUpdates.stop();
    const sessionUpdates = new AcpTranslatorSessionUpdates({
      connection: harness.connection,
      eventLedger,
      getAvailableCommands: async () => [],
      log: () => {},
    });
    const runtime = new AcpLocalTurnRuntime({
      connection: harness.connection,
      sessionRuntime: createSessionRuntime(),
      sessionUpdates,
      executeAgent: executeAgent as never,
      createRunId: () => `run-${promptCount + 1}`,
    });
    await eventLedger.startSession({
      sessionId: harness.session.sessionId,
      sessionKey: harness.session.sessionKey,
      cwd: harness.session.cwd,
      complete: true,
    });

    const first = prompt(runtime, harness.session, "first");
    await vi.waitFor(() => expect(promptCount).toBe(1));
    const second = prompt(runtime, harness.session, "second");

    firstPromptGate.resolve();
    await expect(first).resolves.toEqual({ stopReason: "cancelled" });
    await expect(second).resolves.toEqual({ stopReason: "end_turn" });
    expect(executeAgent).toHaveBeenCalledTimes(1);
    await expect(
      eventLedger.readReplay({
        sessionId: harness.session.sessionId,
        sessionKey: harness.session.sessionKey,
      }),
    ).resolves.toMatchObject({
      events: [
        expect.objectContaining({
          update: {
            sessionUpdate: "user_message_chunk",
            content: { type: "text", text: "second" },
          },
        }),
      ],
    });
  });

  it("drains projected events before surfacing execution or transport failures", async () => {
    const executeAgent = vi.fn(async (opts: { runId: string }) => {
      emitAgentEvent({
        runId: opts.runId,
        stream: "assistant",
        data: { delta: "partial" },
      });
      throw new Error("model failed");
    });
    const first = createHarness(executeAgent);
    await expect(prompt(first.runtime, first.session)).rejects.toThrow("model failed");
    expect(first.updates).toContainEqual({
      sessionId: "session-1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "partial" },
      },
    });

    const second = createHarness(
      vi.fn(async (opts: { runId: string }) => {
        emitAgentEvent({
          runId: opts.runId,
          stream: "assistant",
          data: { delta: "answer" },
        });
        return { payloads: [], meta: {} };
      }),
      {
        sessionUpdate: vi.fn(async () => {
          throw new Error("session update transport failed");
        }),
      },
    );
    await expect(prompt(second.runtime, second.session)).rejects.toThrow(
      "session update transport failed",
    );
  });

  it.each([
    {
      stream: "lifecycle",
      data: { phase: "error", error: "provider exploded", aborted: true },
    },
    {
      stream: "error",
      data: { error: "runtime stream failed" },
    },
  ] as const)("rejects terminal $stream event failures", async ({ stream, data }) => {
    const harness = createHarness(
      vi.fn(async (opts: { runId: string }) => {
        emitAgentEvent({
          runId: opts.runId,
          stream,
          data,
        });
        return { payloads: [], meta: {} };
      }),
    );

    await expect(prompt(harness.runtime, harness.session)).rejects.toThrow(
      stream === "lifecycle" ? "provider exploded" : "runtime stream failed",
    );
  });

  it("allows a later successful lifecycle to supersede a retryable error", async () => {
    const harness = createHarness(
      vi.fn(async (opts: { runId: string }) => {
        emitAgentEvent({
          runId: opts.runId,
          stream: "lifecycle",
          data: {
            phase: "error",
            error: "first provider failed",
            aborted: true,
            stopReason: "cancelled",
          },
        });
        emitAgentEvent({
          runId: opts.runId,
          stream: "lifecycle",
          data: { phase: "start", startedAt: Date.now() },
        });
        emitAgentEvent({
          runId: opts.runId,
          stream: "lifecycle",
          data: { phase: "end", stopReason: "end_turn" },
        });
        return { payloads: [], meta: {} };
      }),
    );

    await expect(prompt(harness.runtime, harness.session)).resolves.toEqual({
      stopReason: "end_turn",
    });
  });

  it("preserves a terminal lifecycle error across its cleanup end event", async () => {
    const harness = createHarness(
      vi.fn(async (opts: { runId: string }) => {
        emitAgentEvent({
          runId: opts.runId,
          stream: "lifecycle",
          data: { phase: "error", error: "provider remained broken" },
        });
        emitAgentEvent({
          runId: opts.runId,
          stream: "lifecycle",
          data: { phase: "end" },
        });
        return { payloads: [], meta: {} };
      }),
    );

    await expect(prompt(harness.runtime, harness.session)).rejects.toThrow(
      "provider remained broken",
    );
  });

  it("retries terminal tool projection during failure cleanup", async () => {
    const observed: SessionUpdate[] = [];
    let updateCount = 0;
    const harness = createHarness(
      vi.fn(async (opts: { runId: string }) => {
        emitAgentEvent({
          runId: opts.runId,
          stream: "tool",
          data: {
            phase: "start",
            toolCallId: "tool-retry",
            name: "exec",
            args: { command: "echo retry" },
          },
        });
        return { payloads: [], meta: {} };
      }),
      {
        sessionUpdate: vi.fn(async ({ update }: { update: SessionUpdate }) => {
          updateCount += 1;
          if (updateCount === 2) {
            throw new Error("transient session update failure");
          }
          observed.push(update);
        }),
      },
    );

    await expect(prompt(harness.runtime, harness.session)).rejects.toThrow(
      "transient session update failure",
    );
    expect(observed.at(-1)).toMatchObject({
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-retry",
      status: "failed",
      rawOutput: "Turn failed while finalizing agent output.",
    });
  });

  it("seals and settles setup plus active turns during shutdown", async () => {
    const gate = deferred<void>();
    const executeAgent = vi.fn(
      async (opts: { abortSignal: AbortSignal }) =>
        await new Promise<{ payloads: never[]; meta: { aborted: true } }>((resolve) => {
          opts.abortSignal.addEventListener(
            "abort",
            () => resolve({ payloads: [], meta: { aborted: true } }),
            { once: true },
          );
        }),
    );
    const harness = createHarness(executeAgent);
    const baseLedger = createInMemoryAcpEventLedger();
    const sessionUpdates = new AcpTranslatorSessionUpdates({
      connection: harness.connection,
      eventLedger: {
        ...baseLedger,
        recordUserPrompt: async (params) => {
          await gate.promise;
          await baseLedger.recordUserPrompt(params);
        },
      },
      getAvailableCommands: async () => [],
      log: () => {},
    });
    const runtime = new AcpLocalTurnRuntime({
      connection: harness.connection,
      sessionRuntime: createSessionRuntime(),
      sessionUpdates,
      executeAgent: executeAgent as never,
    });
    const response = prompt(runtime, harness.session);
    let stopped = false;
    const shutdown = runtime.shutdown().then(() => {
      stopped = true;
    });
    const concurrentShutdown = runtime.shutdown();
    expect(runtime.shutdown()).toBe(concurrentShutdown);
    await Promise.resolve();
    expect(stopped).toBe(false);

    gate.resolve();
    await Promise.all([shutdown, concurrentShutdown]);
    await expect(response).resolves.toEqual({ stopReason: "cancelled" });
    expect(executeAgent).not.toHaveBeenCalled();
  });
});
