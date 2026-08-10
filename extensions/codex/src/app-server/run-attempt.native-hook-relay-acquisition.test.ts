import path from "node:path";
import {
  createEmptyPluginRegistry,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCodexNativeHookRelay } from "./native-hook-relay.js";
import {
  clearCodexNativeHookRelayOwners,
  codexNativeHookRelayOwnerCount,
} from "./native-hook-relay.test-harness.js";
import {
  createParams,
  createResumeHarness,
  createStartedThreadHarness,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  tempDir,
} from "./run-attempt-test-harness.js";
import {
  readCodexAppServerBinding,
  writeCodexAppServerBinding,
} from "./session-binding.test-helpers.js";

const relayMock = vi.hoisted(() => ({
  renewalStatus: "foreign-owner" as "dead" | "foreign-owner" | "live" | "unknown",
  commandForEvent: vi.fn(() => "must-not-reach-codex"),
  registrationGeneration: undefined as string | undefined,
  registrations: [] as Array<{ agentId?: string; sessionKey?: string; generation?: string }>,
  rebindAttempt: vi.fn<(_binding: unknown) => boolean>(() => true),
  unregister: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/agent-harness-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/agent-harness-runtime")>();
  return {
    ...actual,
    registerNativeHookRelay: (params: Parameters<typeof actual.registerNativeHookRelay>[0]) => {
      relayMock.registrationGeneration = params.generation;
      relayMock.registrations.push(params);
      return {
        ...params,
        relayId: params.relayId ?? "unavailable-relay",
        generation: params.generation ?? "unavailable-generation",
        allowedEvents: params.allowedEvents ?? [],
        expiresAtMs: Date.now() + 60_000,
        shouldRelayEvent: () => true,
        toolMatcherForEvent: () => undefined,
        commandForEvent: relayMock.commandForEvent,
        renew: () => undefined,
        renewStatus: () => relayMock.renewalStatus,
        rebindAttempt: relayMock.rebindAttempt,
        unregister: relayMock.unregister,
      };
    },
  };
});

setupRunAttemptTestHooks();

function threadRpcRequests(requests: Array<{ method: string }>) {
  return requests.filter((request) =>
    ["thread/start", "thread/resume", "turn/start"].includes(request.method),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  relayMock.registrationGeneration = undefined;
  relayMock.registrations.length = 0;
  relayMock.renewalStatus = "foreign-owner";
});

afterEach(() => {
  setActivePluginRegistry(createEmptyPluginRegistry());
});

describe("Codex native hook relay acquisition", () => {
  it.each([
    { action: "start", renewalStatus: "foreign-owner" },
    { action: "start", renewalStatus: "dead" },
    { action: "resume", renewalStatus: "foreign-owner" },
    { action: "resume", renewalStatus: "dead" },
  ] as const)(
    "blocks a cold $action when relay ownership is $renewalStatus",
    async ({ action, renewalStatus }) => {
      relayMock.renewalStatus = renewalStatus;
      const sessionFile = path.join(tempDir, `relay-${action}-${renewalStatus}.jsonl`);
      const workspaceDir = path.join(tempDir, `workspace-${action}-${renewalStatus}`);
      const harness = action === "resume" ? createResumeHarness() : createStartedThreadHarness();
      if (action === "resume") {
        await writeCodexAppServerBinding(sessionFile, {
          threadId: "thread-existing",
          cwd: workspaceDir,
          model: "gpt-5.4-codex",
          modelProvider: "openai",
          historyCoveredThrough: new Date().toISOString(),
          webSearchThreadConfigFingerprint: JSON.stringify({
            "features.standalone_web_search": false,
            web_search: "disabled",
          }),
          dynamicToolsFingerprint: "[]",
          nativeHookRelayGeneration: "persisted-relay-generation",
        });
      }

      await expect(
        runCodexAppServerAttempt(createParams(sessionFile, workspaceDir), {
          nativeHookRelay: { enabled: true, events: ["pre_tool_use"] },
        }),
      ).rejects.toThrow(
        `Codex native hook relay is unavailable (${renewalStatus}); refusing to start or resume a thread without OpenClaw policy hooks`,
      );

      expect(threadRpcRequests(harness.requests)).toEqual([]);
      expect(relayMock.unregister).toHaveBeenCalled();
    },
  );

  it("blocks a persisted-generation resume with unknown ownership before Codex RPC", async () => {
    const sessionFile = path.join(tempDir, "relay-resume-unknown.jsonl");
    const workspaceDir = path.join(tempDir, "workspace-resume-unknown");
    relayMock.renewalStatus = "live";
    const firstHarness = createStartedThreadHarness();
    const firstRun = runCodexAppServerAttempt(createParams(sessionFile, workspaceDir), {
      nativeHookRelay: { enabled: true, events: ["pre_tool_use"] },
    });
    await firstHarness.waitForMethod("turn/start");
    await firstHarness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await firstRun;
    const persistedGeneration = (await readCodexAppServerBinding(sessionFile))
      ?.nativeHookRelayGeneration;
    expect(persistedGeneration).toBeTruthy();

    // Reset only the in-process route owner. This proves the persisted generation
    // is reused and unknown bridge ownership fails before any Codex RPC.
    clearCodexNativeHookRelayOwners();
    vi.clearAllMocks();
    relayMock.renewalStatus = "unknown";
    const harness = createResumeHarness();

    await expect(
      runCodexAppServerAttempt(createParams(sessionFile, workspaceDir), {
        nativeHookRelay: { enabled: true, events: ["pre_tool_use"] },
      }),
    ).rejects.toThrow(
      "Codex native hook relay is unavailable (unknown); refusing to start or resume a thread without OpenClaw policy hooks",
    );

    expect(relayMock.registrationGeneration).toBe(persistedGeneration);
    expect(relayMock.commandForEvent).not.toHaveBeenCalled();
    expect(threadRpcRequests(harness.requests)).toEqual([]);
    expect(relayMock.unregister).toHaveBeenCalled();
  });

  it("rejects uncertain adoption before rebinding a child-owned resume route", async () => {
    const sessionFile = path.join(tempDir, "relay-live-route-resume-unknown.jsonl");
    const workspaceDir = path.join(tempDir, "workspace-live-route-resume-unknown");
    relayMock.renewalStatus = "live";
    const firstHarness = createStartedThreadHarness();
    const firstRun = runCodexAppServerAttempt(createParams(sessionFile, workspaceDir), {
      nativeHookRelay: { enabled: true, events: ["pre_tool_use"] },
    });
    await firstHarness.waitForMethod("turn/start");
    await firstHarness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await firstRun;
    const generation = (await readCodexAppServerBinding(sessionFile))?.nativeHookRelayGeneration;
    expect(generation).toBeTruthy();
    if (!generation) {
      throw new Error("Expected persisted native hook relay generation");
    }

    const oldRequester = { senderId: "old-sender", senderIsOwner: false };
    const holder = createCodexNativeHookRelay({
      options: { enabled: true, ttlMs: 2_000 },
      generation,
      events: ["pre_tool_use"],
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      config: undefined,
      runId: "old-run",
      requester: oldRequester,
      attemptTimeoutMs: 1_000,
      startupTimeoutMs: 1_000,
      turnStartTimeoutMs: 1_000,
      loopDetectionPreToolUseRelay: true,
      signal: new AbortController().signal,
      onPreToolUseFailure: vi.fn(),
    });
    expect(holder.status).toBe("active");
    if (holder.status !== "active") {
      throw new Error("Expected retained child-owned relay route");
    }
    const releaseChild = holder.lease.acquireChild("surviving-child");
    holder.lease.releaseParent();
    const retiredBinding = relayMock.rebindAttempt.mock.calls.at(-1)?.[0];
    const rebindCount = relayMock.rebindAttempt.mock.calls.length;
    relayMock.renewalStatus = "unknown";
    const harness = createResumeHarness();
    const params = createParams(sessionFile, workspaceDir, { runId: "rejected-run" });
    params.senderId = "new-owner";
    params.senderIsOwner = true;

    await expect(
      runCodexAppServerAttempt(params, {
        nativeHookRelay: { enabled: true, events: ["pre_tool_use"] },
      }),
    ).rejects.toThrow(
      "Codex native hook relay is unavailable (unknown); refusing to start or resume a thread without OpenClaw policy hooks",
    );

    expect(threadRpcRequests(harness.requests)).toEqual([]);
    expect(relayMock.rebindAttempt).toHaveBeenCalledTimes(rebindCount);
    expect(relayMock.rebindAttempt.mock.calls.at(-1)?.[0]).toBe(retiredBinding);
    expect(retiredBinding).toMatchObject({ runId: "old-run", requester: oldRequester });
    expect(
      relayMock.registrations.map(({ agentId, sessionKey, generation: registeredGeneration }) => ({
        agentId,
        sessionKey,
        generation: registeredGeneration,
      })),
    ).toEqual([
      {
        agentId: "main",
        sessionKey: "agent:main:session-1",
        generation,
      },
    ]);
    expect(relayMock.unregister).not.toHaveBeenCalled();
    expect(codexNativeHookRelayOwnerCount()).toBe(1);

    relayMock.renewalStatus = "live";
    const recovered = createCodexNativeHookRelay({
      options: { enabled: true, ttlMs: 30_000 },
      generation,
      events: ["pre_tool_use"],
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      config: undefined,
      runId: "recovered-run",
      requester: { senderId: "recovered-owner", senderIsOwner: true },
      attemptTimeoutMs: 1_000,
      startupTimeoutMs: 1_000,
      turnStartTimeoutMs: 1_000,
      loopDetectionPreToolUseRelay: true,
      signal: new AbortController().signal,
      onPreToolUseFailure: vi.fn(),
    });
    expect(recovered.status).toBe("active");
    if (recovered.status === "active") {
      recovered.lease.releaseParent();
    }
    releaseChild?.();
    expect(codexNativeHookRelayOwnerCount()).toBe(1);
    clearCodexNativeHookRelayOwners();
    expect(relayMock.unregister).toHaveBeenCalledTimes(1);
  });
});
