import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCodexNativeHookRelay as acquireCodexNativeHookRelay,
  type CodexNativeHookRelayLease,
} from "./native-hook-relay.js";
import {
  clearCodexNativeHookRelayOwners,
  codexNativeHookRelayOwnerCount,
} from "./native-hook-relay.test-harness.js";

const relayMocks = vi.hoisted(() => ({
  register: vi.fn(),
  renew: vi.fn<(ttlMs?: number) => void>(),
  renewStatus: vi.fn(),
  unregister: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/agent-harness-runtime", () => ({
  embeddedAgentLog: { debug: vi.fn() },
  registerNativeHookRelay: relayMocks.register,
}));

function createCodexNativeHookRelay(
  params: Parameters<typeof acquireCodexNativeHookRelay>[0],
): CodexNativeHookRelayLease | undefined {
  const acquisition = acquireCodexNativeHookRelay(params);
  return acquisition.status === "active" ? acquisition.lease : undefined;
}

afterEach(() => {
  clearCodexNativeHookRelayOwners();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("Codex native hook relay renewal compatibility", () => {
  it("does not return an overlay while the initial relay claim is unknown", () => {
    relayMocks.renewStatus.mockReturnValue("unknown");
    relayMocks.register.mockReturnValue({
      relayId: "initial-unknown-relay",
      provider: "codex",
      generation: "initial-unknown-generation",
      sessionId: "initial-unknown-session",
      runId: "initial-unknown-run",
      allowedEvents: ["pre_tool_use"],
      expiresAtMs: Date.now() + 1_000,
      shouldRelayEvent: () => true,
      toolMatcherForEvent: () => undefined,
      commandForEvent: () => "fail-closed-overlay-command",
      renew: relayMocks.renew,
      renewStatus: relayMocks.renewStatus,
      rebindAttempt: () => true,
      unregister: relayMocks.unregister,
    });

    expect(
      acquireCodexNativeHookRelay({
        options: { enabled: true, ttlMs: 1_000 },
        generation: "initial-unknown-generation",
        events: ["pre_tool_use"],
        agentId: "main",
        sessionId: "initial-unknown-session",
        sessionKey: "agent:main:initial-unknown-session",
        config: undefined,
        runId: "initial-unknown-run",
        attemptTimeoutMs: 1_000,
        startupTimeoutMs: 1_000,
        turnStartTimeoutMs: 1_000,
        loopDetectionPreToolUseRelay: true,
        signal: new AbortController().signal,
        onPreToolUseFailure: vi.fn(),
      }),
    ).toEqual({ status: "unavailable", reason: "unknown" });

    expect(codexNativeHookRelayOwnerCount()).toBe(0);
    expect(relayMocks.register).toHaveBeenCalledTimes(1);
    expect(relayMocks.renewStatus).toHaveBeenCalledTimes(1);
    expect(relayMocks.unregister).toHaveBeenCalledTimes(1);
  });

  it("does not return a route when the initial publication is foreign-owned", () => {
    relayMocks.renewStatus.mockReturnValue("foreign-owner");
    relayMocks.register.mockReturnValue({
      relayId: "initial-foreign-relay",
      provider: "codex",
      generation: "initial-foreign-generation",
      sessionId: "initial-foreign-session",
      runId: "initial-foreign-run",
      allowedEvents: ["pre_tool_use"],
      expiresAtMs: Date.now() + 1_000,
      shouldRelayEvent: () => true,
      toolMatcherForEvent: () => undefined,
      commandForEvent: () => "must-not-be-returned",
      renew: relayMocks.renew,
      renewStatus: relayMocks.renewStatus,
      rebindAttempt: () => true,
      unregister: relayMocks.unregister,
    });

    expect(
      acquireCodexNativeHookRelay({
        options: { enabled: true, ttlMs: 1_000 },
        generation: "initial-foreign-generation",
        events: ["pre_tool_use"],
        agentId: "main",
        sessionId: "initial-foreign-session",
        sessionKey: "agent:main:initial-foreign-session",
        config: undefined,
        runId: "initial-foreign-run",
        attemptTimeoutMs: 1_000,
        startupTimeoutMs: 1_000,
        turnStartTimeoutMs: 1_000,
        loopDetectionPreToolUseRelay: true,
        signal: new AbortController().signal,
        onPreToolUseFailure: vi.fn(),
      }),
    ).toEqual({ status: "unavailable", reason: "foreign-owner" });
    expect(relayMocks.unregister).toHaveBeenCalledTimes(1);
    expect(codexNativeHookRelayOwnerCount()).toBe(0);
  });

  it("retries an explicitly unknown renewal on the same registration", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    relayMocks.renewStatus
      .mockReturnValueOnce("live")
      .mockReturnValueOnce("unknown")
      .mockReturnValueOnce("live");
    relayMocks.register.mockReturnValue({
      relayId: "status-relay",
      provider: "codex",
      generation: "status-generation",
      sessionId: "status-session",
      runId: "status-run",
      allowedEvents: ["pre_tool_use"],
      expiresAtMs: Date.now() + 1_000,
      shouldRelayEvent: () => true,
      toolMatcherForEvent: () => undefined,
      commandForEvent: () => "status-relay-command",
      renew: relayMocks.renew,
      renewStatus: relayMocks.renewStatus,
      rebindAttempt: () => true,
      unregister: relayMocks.unregister,
    });
    const relay = createCodexNativeHookRelay({
      options: { enabled: true, ttlMs: 1_000 },
      generation: "status-generation",
      events: ["pre_tool_use"],
      agentId: "main",
      sessionId: "status-session",
      sessionKey: "agent:main:status-session",
      config: undefined,
      runId: "status-run",
      attemptTimeoutMs: 1_000,
      startupTimeoutMs: 1_000,
      turnStartTimeoutMs: 1_000,
      loopDetectionPreToolUseRelay: true,
      signal: new AbortController().signal,
      onPreToolUseFailure: vi.fn(),
    });

    relay?.renew(2_000);
    expect(relayMocks.renewStatus).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(999);
    expect(relayMocks.renewStatus).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);

    expect(relayMocks.renewStatus).toHaveBeenCalledTimes(3);
    expect(relayMocks.register).toHaveBeenCalledTimes(1);
    expect(relayMocks.unregister).not.toHaveBeenCalled();
    relay?.releaseParent();
  });

  it("cancels an unknown-renewal retry when the attempt aborts", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    const abortController = new AbortController();
    relayMocks.renewStatus.mockReturnValue("unknown").mockReturnValueOnce("live");
    relayMocks.register.mockReturnValue({
      relayId: "aborted-status-relay",
      provider: "codex",
      generation: "aborted-status-generation",
      sessionId: "aborted-status-session",
      runId: "aborted-status-run",
      allowedEvents: ["pre_tool_use"],
      expiresAtMs: Date.now() + 1_000,
      shouldRelayEvent: () => true,
      toolMatcherForEvent: () => undefined,
      commandForEvent: () => "aborted-status-relay-command",
      renew: relayMocks.renew,
      renewStatus: relayMocks.renewStatus,
      rebindAttempt: () => true,
      unregister: relayMocks.unregister,
    });
    const relay = createCodexNativeHookRelay({
      options: { enabled: true, ttlMs: 1_000 },
      generation: "aborted-status-generation",
      events: ["pre_tool_use"],
      agentId: "main",
      sessionId: "aborted-status-session",
      sessionKey: "agent:main:aborted-status-session",
      config: undefined,
      runId: "aborted-status-run",
      attemptTimeoutMs: 1_000,
      startupTimeoutMs: 1_000,
      turnStartTimeoutMs: 1_000,
      loopDetectionPreToolUseRelay: true,
      signal: abortController.signal,
      onPreToolUseFailure: vi.fn(),
    });

    relay?.renew(2_000);
    expect(relayMocks.renewStatus).toHaveBeenCalledTimes(2);
    abortController.abort("cancelled");
    await vi.advanceTimersByTimeAsync(1_001);

    expect(relayMocks.renewStatus).toHaveBeenCalledTimes(2);
    expect(relayMocks.unregister).toHaveBeenCalledTimes(1);
  });

  it("cancels a stale TTL retry after adoption renews the route authoritatively", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    relayMocks.renewStatus
      .mockReturnValueOnce("live")
      .mockReturnValueOnce("unknown")
      .mockReturnValueOnce("live");
    relayMocks.register.mockReturnValue({
      relayId: "adopted-ttl-relay",
      provider: "codex",
      generation: "adopted-ttl-generation",
      sessionId: "adopted-ttl-session",
      runId: "adopted-ttl-run-1",
      allowedEvents: ["pre_tool_use"],
      expiresAtMs: Date.now() + 1_000,
      shouldRelayEvent: () => true,
      toolMatcherForEvent: () => undefined,
      commandForEvent: () => "adopted-ttl-command",
      renew: relayMocks.renew,
      renewStatus: relayMocks.renewStatus,
      rebindAttempt: () => true,
      unregister: relayMocks.unregister,
    });
    const attemptParams = {
      generation: "adopted-ttl-generation",
      events: ["pre_tool_use"] as const,
      agentId: "main",
      sessionId: "adopted-ttl-session",
      sessionKey: "agent:main:adopted-ttl-session",
      config: undefined,
      attemptTimeoutMs: 1_000,
      startupTimeoutMs: 1_000,
      turnStartTimeoutMs: 1_000,
      loopDetectionPreToolUseRelay: true,
      signal: new AbortController().signal,
      onPreToolUseFailure: vi.fn(),
    };
    const first = createCodexNativeHookRelay({
      ...attemptParams,
      options: { enabled: true, ttlMs: 2_000 },
      runId: "adopted-ttl-run-1",
    });
    first?.renew(2_000);
    expect(relayMocks.renewStatus).toHaveBeenLastCalledWith(2_000);

    const second = createCodexNativeHookRelay({
      ...attemptParams,
      options: { enabled: true, ttlMs: 20_000 },
      runId: "adopted-ttl-run-2",
    });
    expect(relayMocks.renewStatus).toHaveBeenLastCalledWith(20_000);
    expect(relayMocks.renewStatus).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(1_001);
    expect(relayMocks.renewStatus).toHaveBeenCalledTimes(3);
    first?.releaseParent();
    second?.releaseParent();
  });

  it("rejects uncertain adoption before rebinding a child-owned route", () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    relayMocks.renewStatus
      .mockReturnValueOnce("live")
      .mockReturnValueOnce("unknown")
      .mockReturnValueOnce("live");
    const rebindAttempt = vi.fn<(_binding: unknown) => boolean>(() => true);
    relayMocks.register.mockReturnValue({
      relayId: "uncertain-adoption-relay",
      provider: "codex",
      generation: "uncertain-adoption-generation",
      sessionId: "uncertain-adoption-session",
      runId: "old-run",
      allowedEvents: ["pre_tool_use"],
      expiresAtMs: Date.now() + 1_000,
      shouldRelayEvent: () => true,
      toolMatcherForEvent: () => undefined,
      commandForEvent: () => "uncertain-adoption-command",
      renew: relayMocks.renew,
      renewStatus: relayMocks.renewStatus,
      rebindAttempt,
      unregister: relayMocks.unregister,
    });
    const routeIdentity = {
      generation: "uncertain-adoption-generation",
      events: ["pre_tool_use"] as const,
      agentId: "main",
      sessionId: "uncertain-adoption-session",
      sessionKey: "agent:main:uncertain-adoption-session",
      config: undefined,
      attemptTimeoutMs: 1_000,
      startupTimeoutMs: 1_000,
      turnStartTimeoutMs: 1_000,
      loopDetectionPreToolUseRelay: true,
      signal: new AbortController().signal,
      onPreToolUseFailure: vi.fn(),
    };
    const oldRequester = { senderId: "old-sender", senderIsOwner: false };
    const first = acquireCodexNativeHookRelay({
      ...routeIdentity,
      options: { enabled: true, ttlMs: 2_000 },
      runId: "old-run",
      requester: oldRequester,
    });
    expect(first.status).toBe("active");
    if (first.status !== "active") {
      throw new Error("Expected initial relay acquisition to be active");
    }
    const releaseChild = first.lease.acquireChild("surviving-child");
    expect(releaseChild).toBeTypeOf("function");
    first.lease.releaseParent();
    const retiredBinding = rebindAttempt.mock.calls.at(-1)?.[0];
    const rebindCount = rebindAttempt.mock.calls.length;

    expect(
      acquireCodexNativeHookRelay({
        ...routeIdentity,
        options: { enabled: true, ttlMs: 20_000 },
        runId: "rejected-run",
        requester: { senderId: "new-owner", senderIsOwner: true },
      }),
    ).toEqual({ status: "unavailable", reason: "unknown" });

    expect(relayMocks.register).toHaveBeenCalledTimes(1);
    expect(relayMocks.unregister).not.toHaveBeenCalled();
    expect(rebindAttempt).toHaveBeenCalledTimes(rebindCount);
    expect(rebindAttempt.mock.calls.at(-1)?.[0]).toBe(retiredBinding);
    expect(retiredBinding).toMatchObject({ runId: "old-run", requester: oldRequester });
    expect(codexNativeHookRelayOwnerCount()).toBe(1);

    const recovered = acquireCodexNativeHookRelay({
      ...routeIdentity,
      options: { enabled: true, ttlMs: 30_000 },
      runId: "recovered-run",
      requester: { senderId: "recovered-owner", senderIsOwner: true },
    });
    expect(recovered.status).toBe("active");
    if (recovered.status === "active") {
      recovered.lease.releaseParent();
    }
    releaseChild?.();
    vi.advanceTimersByTime(60_000);
    expect(relayMocks.register).toHaveBeenCalledTimes(1);
    expect(relayMocks.unregister).toHaveBeenCalledTimes(1);
  });

  it("ignores stale attempt renewal after a later attempt adopts the route", () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    relayMocks.renewStatus.mockReturnValue("live");
    relayMocks.register.mockReturnValue({
      relayId: "stale-attempt-renewal-relay",
      provider: "codex",
      generation: "stale-attempt-renewal-generation",
      sessionId: "stale-attempt-renewal-session",
      runId: "stale-attempt-renewal-run-1",
      allowedEvents: ["pre_tool_use"],
      expiresAtMs: Date.now() + 1_000,
      shouldRelayEvent: () => true,
      toolMatcherForEvent: () => undefined,
      commandForEvent: () => "stale-attempt-renewal-command",
      renew: relayMocks.renew,
      renewStatus: relayMocks.renewStatus,
      rebindAttempt: () => true,
      unregister: relayMocks.unregister,
    });
    const attemptParams = {
      generation: "stale-attempt-renewal-generation",
      events: ["pre_tool_use"] as const,
      agentId: "main",
      sessionId: "stale-attempt-renewal-session",
      sessionKey: "agent:main:stale-attempt-renewal-session",
      config: undefined,
      attemptTimeoutMs: 1_000,
      startupTimeoutMs: 1_000,
      turnStartTimeoutMs: 1_000,
      loopDetectionPreToolUseRelay: true,
      signal: new AbortController().signal,
      onPreToolUseFailure: vi.fn(),
    };
    const first = createCodexNativeHookRelay({
      ...attemptParams,
      options: { enabled: true, ttlMs: 2_000 },
      runId: "stale-attempt-renewal-run-1",
    });
    const second = createCodexNativeHookRelay({
      ...attemptParams,
      options: { enabled: true, ttlMs: 20_000 },
      runId: "stale-attempt-renewal-run-2",
    });
    expect(relayMocks.renewStatus).toHaveBeenCalledTimes(2);
    expect(relayMocks.renewStatus).toHaveBeenLastCalledWith(20_000);

    first?.renew(500);
    expect(relayMocks.renewStatus).toHaveBeenCalledTimes(2);

    second?.renew(30_000);
    expect(relayMocks.renewStatus).toHaveBeenCalledTimes(3);
    expect(relayMocks.renewStatus).toHaveBeenLastCalledWith(30_000);
    first?.releaseParent();
    second?.releaseParent();
  });

  it("fences an unknown-renewal retry from a replacement registration", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    const firstRenewStatus = vi
      .fn()
      .mockReturnValue("unknown")
      .mockReturnValueOnce("live")
      .mockReturnValueOnce("unknown")
      .mockReturnValueOnce("live");
    const firstRebind = vi
      .fn()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    const secondRenewStatus = vi.fn().mockReturnValue("live");
    const secondUnregister = vi.fn();
    relayMocks.register
      .mockReturnValueOnce({
        relayId: "replacement-status-relay",
        provider: "codex",
        generation: "replacement-status-generation",
        sessionId: "replacement-status-session",
        runId: "replacement-status-run-1",
        allowedEvents: ["pre_tool_use"],
        expiresAtMs: Date.now() + 1_000,
        shouldRelayEvent: () => true,
        toolMatcherForEvent: () => undefined,
        commandForEvent: () => "replacement-status-relay-command-1",
        renew: relayMocks.renew,
        renewStatus: firstRenewStatus,
        rebindAttempt: firstRebind,
        unregister: relayMocks.unregister,
      })
      .mockReturnValueOnce({
        relayId: "replacement-status-relay",
        provider: "codex",
        generation: "replacement-status-generation",
        sessionId: "replacement-status-session",
        runId: "replacement-status-run-2",
        allowedEvents: ["pre_tool_use"],
        expiresAtMs: Date.now() + 1_000,
        shouldRelayEvent: () => true,
        toolMatcherForEvent: () => undefined,
        commandForEvent: () => "replacement-status-relay-command-2",
        renew: relayMocks.renew,
        renewStatus: secondRenewStatus,
        rebindAttempt: () => true,
        unregister: secondUnregister,
      });
    const attemptParams = {
      options: { enabled: true, ttlMs: 1_000 },
      generation: "replacement-status-generation",
      events: ["pre_tool_use"] as const,
      agentId: "main",
      sessionId: "replacement-status-session",
      sessionKey: "agent:main:replacement-status-session",
      config: undefined,
      attemptTimeoutMs: 1_000,
      startupTimeoutMs: 1_000,
      turnStartTimeoutMs: 1_000,
      loopDetectionPreToolUseRelay: true,
      signal: new AbortController().signal,
      onPreToolUseFailure: vi.fn(),
    };
    const first = createCodexNativeHookRelay({
      ...attemptParams,
      runId: "replacement-status-run-1",
    });
    first?.renew(2_000);
    expect(firstRenewStatus).toHaveBeenCalledTimes(2);

    const second = createCodexNativeHookRelay({
      ...attemptParams,
      runId: "replacement-status-run-2",
    });
    await vi.advanceTimersByTimeAsync(1_001);

    expect(relayMocks.register).toHaveBeenCalledTimes(2);
    expect(firstRenewStatus).toHaveBeenCalledTimes(3);
    expect(secondRenewStatus).toHaveBeenCalledTimes(1);
    first?.releaseParent();
    second?.releaseParent();
    expect(secondUnregister).toHaveBeenCalledTimes(1);
  });

  it("retains child ownership while a dead relay replacement recovers from unknown", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    const firstRenewStatus = vi
      .fn()
      .mockReturnValueOnce("live")
      .mockReturnValueOnce("unknown")
      .mockReturnValueOnce("dead");
    const secondRenewStatus = vi
      .fn()
      .mockReturnValueOnce("unknown")
      .mockReturnValueOnce("unknown")
      .mockReturnValue("live");
    const secondUnregister = vi.fn();
    const rebindAttempt = vi.fn<(_binding: unknown) => boolean>(() => true);
    relayMocks.register
      .mockReturnValueOnce({
        relayId: "recovering-replacement-relay",
        provider: "codex",
        generation: "recovering-replacement-generation",
        sessionId: "recovering-replacement-session",
        runId: "recovering-replacement-run",
        allowedEvents: ["pre_tool_use"],
        expiresAtMs: Date.now() + 20_000,
        shouldRelayEvent: () => true,
        toolMatcherForEvent: () => undefined,
        commandForEvent: () => "recovering-replacement-command-1",
        renew: relayMocks.renew,
        renewStatus: firstRenewStatus,
        rebindAttempt,
        unregister: relayMocks.unregister,
      })
      .mockReturnValueOnce({
        relayId: "recovering-replacement-relay",
        provider: "codex",
        generation: "recovering-replacement-generation",
        sessionId: "recovering-replacement-session",
        runId: "recovering-replacement-run",
        allowedEvents: ["pre_tool_use"],
        expiresAtMs: Date.now() + 20_000,
        shouldRelayEvent: () => true,
        toolMatcherForEvent: () => undefined,
        commandForEvent: () => "recovering-replacement-command-2",
        renew: relayMocks.renew,
        renewStatus: secondRenewStatus,
        rebindAttempt,
        unregister: secondUnregister,
      });
    const routeIdentity = {
      options: { enabled: true, ttlMs: 20_000 },
      generation: "recovering-replacement-generation",
      events: ["pre_tool_use"] as const,
      agentId: "main",
      sessionId: "recovering-replacement-session",
      sessionKey: "agent:main:recovering-replacement-session",
      config: undefined,
      attemptTimeoutMs: 1_000,
      startupTimeoutMs: 1_000,
      turnStartTimeoutMs: 1_000,
      loopDetectionPreToolUseRelay: true,
      signal: new AbortController().signal,
      onPreToolUseFailure: vi.fn(),
    };
    const relay = createCodexNativeHookRelay({
      ...routeIdentity,
      runId: "recovering-replacement-run",
    });
    const releaseChild = relay?.acquireChild("surviving-child");
    relay?.renew(20_000);
    relay?.releaseParent();
    const retainedBinding = rebindAttempt.mock.calls.at(-1)?.[0];
    const rebindCount = rebindAttempt.mock.calls.length;

    await vi.advanceTimersByTimeAsync(1_000);

    expect(relayMocks.register).toHaveBeenCalledTimes(2);
    expect(secondRenewStatus).toHaveBeenCalledTimes(1);
    expect(secondUnregister).not.toHaveBeenCalled();
    expect(codexNativeHookRelayOwnerCount()).toBe(1);
    expect(relayMocks.register.mock.calls.at(-1)?.[0]).toMatchObject({
      runId: "recovering-replacement-run",
    });
    expect(
      acquireCodexNativeHookRelay({
        ...routeIdentity,
        runId: "still-uncertain-adopter-run",
      }),
    ).toEqual({ status: "unavailable", reason: "unknown" });
    expect(relayMocks.register).toHaveBeenCalledTimes(2);
    expect(secondRenewStatus).toHaveBeenCalledTimes(2);
    expect(rebindAttempt).toHaveBeenCalledTimes(rebindCount);
    expect(rebindAttempt.mock.calls.at(-1)?.[0]).toBe(retainedBinding);

    await vi.advanceTimersByTimeAsync(1_000);

    expect(secondRenewStatus).toHaveBeenCalledTimes(3);
    expect(secondUnregister).not.toHaveBeenCalled();
    expect(codexNativeHookRelayOwnerCount()).toBe(1);
    const adopted = acquireCodexNativeHookRelay({
      ...routeIdentity,
      runId: "recovered-adopter-run",
    });
    expect(adopted.status).toBe("active");
    expect(relayMocks.register).toHaveBeenCalledTimes(2);
    expect(secondRenewStatus).toHaveBeenCalledTimes(4);
    if (adopted.status === "active") {
      adopted.lease.releaseParent();
    }
    releaseChild?.();
  });

  it("retires a route when an uncertain dead-relay replacement finds a foreign owner", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    const firstRenewStatus = vi
      .fn()
      .mockReturnValueOnce("live")
      .mockReturnValueOnce("unknown")
      .mockReturnValueOnce("dead");
    const secondRenewStatus = vi
      .fn()
      .mockReturnValueOnce("unknown")
      .mockReturnValue("foreign-owner");
    const secondUnregister = vi.fn();
    relayMocks.register
      .mockReturnValueOnce({
        relayId: "foreign-replacement-relay",
        provider: "codex",
        generation: "foreign-replacement-generation",
        sessionId: "foreign-replacement-session",
        runId: "foreign-replacement-run",
        allowedEvents: ["pre_tool_use"],
        expiresAtMs: Date.now() + 1_000,
        shouldRelayEvent: () => true,
        toolMatcherForEvent: () => undefined,
        commandForEvent: () => "foreign-replacement-command-1",
        renew: relayMocks.renew,
        renewStatus: firstRenewStatus,
        rebindAttempt: () => true,
        unregister: relayMocks.unregister,
      })
      .mockReturnValueOnce({
        relayId: "foreign-replacement-relay",
        provider: "codex",
        generation: "foreign-replacement-generation",
        sessionId: "foreign-replacement-session",
        runId: "foreign-replacement-run",
        allowedEvents: ["pre_tool_use"],
        expiresAtMs: Date.now() + 1_000,
        shouldRelayEvent: () => true,
        toolMatcherForEvent: () => undefined,
        commandForEvent: () => "foreign-replacement-command-2",
        renew: relayMocks.renew,
        renewStatus: secondRenewStatus,
        rebindAttempt: () => true,
        unregister: secondUnregister,
      });
    const relay = createCodexNativeHookRelay({
      options: { enabled: true, ttlMs: 20_000 },
      generation: "foreign-replacement-generation",
      events: ["pre_tool_use"],
      agentId: "main",
      sessionId: "foreign-replacement-session",
      sessionKey: "agent:main:foreign-replacement-session",
      config: undefined,
      runId: "foreign-replacement-run",
      attemptTimeoutMs: 1_000,
      startupTimeoutMs: 1_000,
      turnStartTimeoutMs: 1_000,
      loopDetectionPreToolUseRelay: true,
      signal: new AbortController().signal,
      onPreToolUseFailure: vi.fn(),
    });

    const releaseChild = relay?.acquireChild("surviving-child");
    relay?.renew(20_000);
    relay?.releaseParent();
    expect(firstRenewStatus).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(firstRenewStatus).toHaveBeenCalledTimes(3);
    expect(relayMocks.register).toHaveBeenCalledTimes(2);

    expect(secondRenewStatus).toHaveBeenCalledTimes(1);
    expect(secondUnregister).not.toHaveBeenCalled();
    expect(codexNativeHookRelayOwnerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(secondRenewStatus).toHaveBeenCalledTimes(2);
    expect(secondUnregister).toHaveBeenCalledTimes(1);
    expect(codexNativeHookRelayOwnerCount()).toBe(0);
    releaseChild?.();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(relayMocks.register).toHaveBeenCalledTimes(2);
    expect(secondRenewStatus).toHaveBeenCalledTimes(2);
  });

  it("does not expose a lease when binding immediately replaces into foreign ownership", () => {
    const firstUnregister = vi.fn();
    const secondUnregister = vi.fn();
    relayMocks.register
      .mockReturnValueOnce({
        relayId: "binding-replacement-relay",
        provider: "codex",
        generation: "binding-replacement-generation",
        sessionId: "binding-replacement-session",
        runId: "binding-replacement-run",
        allowedEvents: ["pre_tool_use"],
        expiresAtMs: Date.now() + 1_000,
        shouldRelayEvent: () => true,
        toolMatcherForEvent: () => undefined,
        commandForEvent: () => "superseded-command",
        renew: relayMocks.renew,
        renewStatus: () => "live",
        rebindAttempt: () => false,
        unregister: firstUnregister,
      })
      .mockReturnValueOnce({
        relayId: "binding-replacement-relay",
        provider: "codex",
        generation: "binding-replacement-generation",
        sessionId: "binding-replacement-session",
        runId: "binding-replacement-run",
        allowedEvents: ["pre_tool_use"],
        expiresAtMs: Date.now() + 1_000,
        shouldRelayEvent: () => true,
        toolMatcherForEvent: () => undefined,
        commandForEvent: () => "foreign-command",
        renew: relayMocks.renew,
        renewStatus: () => "foreign-owner",
        rebindAttempt: () => true,
        unregister: secondUnregister,
      });

    expect(
      acquireCodexNativeHookRelay({
        options: { enabled: true, ttlMs: 1_000 },
        generation: "binding-replacement-generation",
        events: ["pre_tool_use"],
        agentId: "main",
        sessionId: "binding-replacement-session",
        sessionKey: "agent:main:binding-replacement-session",
        config: undefined,
        runId: "binding-replacement-run",
        attemptTimeoutMs: 1_000,
        startupTimeoutMs: 1_000,
        turnStartTimeoutMs: 1_000,
        loopDetectionPreToolUseRelay: true,
        signal: new AbortController().signal,
        onPreToolUseFailure: vi.fn(),
      }),
    ).toEqual({ status: "unavailable", reason: "foreign-owner" });
    expect(relayMocks.register).toHaveBeenCalledTimes(2);
    expect(secondUnregister).toHaveBeenCalledTimes(1);
    expect(codexNativeHookRelayOwnerCount()).toBe(0);
  });
});
