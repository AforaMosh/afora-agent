import { afterEach, describe, expect, it, vi } from "vitest";
import {
  abortBrowserAllocation,
  acquireBrowserCreationLease,
  closeBrowserAllocation,
  commitBrowserAllocation,
  prepareBrowserAllocation,
  terminateBrowserAllocation,
} from "./talk-client-browser-allocations.js";
import { cleanupTalkConnection } from "./talk-session-registry.js";

type BrowserAllocationDurableState = Parameters<typeof prepareBrowserAllocation>[0]["durableState"];
let allocationSequence = 0;

function createAllocation(
  overrides: {
    agentId?: string;
    sessionKey?: string;
    voiceSessionId?: string;
    connId?: string;
    durableState?: BrowserAllocationDurableState;
    legacyAutoCommit?: boolean;
    allocationId?: string;
  } = {},
) {
  const cancel = vi.fn<() => Promise<void>>(async () => undefined);
  const claimDurable = vi.fn(() => true);
  const closeDurable = vi.fn<() => Promise<void>>(async () => undefined);
  const activateEffects = vi.fn();
  const retireEffects = vi.fn();
  const broadcast = vi.fn();
  return {
    cancel,
    claimDurable,
    closeDurable,
    activateEffects,
    retireEffects,
    broadcast,
    params: {
      agentId: overrides.agentId ?? "main",
      sessionKey: overrides.sessionKey ?? "agent:main:main",
      voiceSessionId: overrides.voiceSessionId ?? "voice-1",
      allocationId:
        overrides.allocationId ??
        `${overrides.connId ?? "conn-1"}-${overrides.voiceSessionId ?? "voice-1"}-${++allocationSequence}`,
      connId: overrides.connId ?? "conn-1",
      durableState: overrides.durableState ?? "created",
      ...(overrides.legacyAutoCommit ? { legacyAutoCommit: true as const } : {}),
      cancel,
      activateEffects,
      retireEffects,
      claimDurable,
      closeDurable,
      broadcast,
      warn: vi.fn(),
    },
  };
}

function identity(
  allocation: Awaited<ReturnType<typeof prepareBrowserAllocation>>,
  connId = allocation.connId,
) {
  return {
    agentId: allocation.agentId,
    sessionKey: allocation.sessionKey,
    voiceSessionId: allocation.voiceSessionId,
    allocationId: allocation.allocationId,
    connId,
  };
}

describe("Talk client browser allocations", () => {
  afterEach(async () => {
    vi.useRealTimers();
    const log = { warn: vi.fn() };
    await Promise.all(
      [
        "conn-1",
        "conn-2",
        "terminal",
        "disconnect",
        "lease-concurrent",
        "lease-close-wins",
        "lease-publication-wins",
      ].map((connId) => cleanupTalkConnection(connId, log)),
    );
  });

  it("fences concurrent creates and drains every lease before disconnect completes", async () => {
    const first = acquireBrowserCreationLease("lease-concurrent");
    const second = acquireBrowserCreationLease("lease-concurrent");
    const closing = cleanupTalkConnection("lease-concurrent", { warn: vi.fn() });
    let settled = false;
    void closing.then(() => {
      settled = true;
    });

    expect(() => first.assertActive()).toThrow("connection closed during startup");
    expect(() => second.assertActive()).toThrow("connection closed during startup");
    expect(() => acquireBrowserCreationLease("lease-concurrent")).toThrow(
      "connection closed during startup",
    );
    first.release();
    await Promise.resolve();
    expect(settled).toBe(false);
    second.release();
    await closing;
    expect(settled).toBe(true);
  });

  it("cancels and closes newly-created durable state after connection close wins", async () => {
    const lease = acquireBrowserCreationLease("lease-close-wins");
    const closing = cleanupTalkConnection("lease-close-wins", { warn: vi.fn() });
    const entry = createAllocation({ connId: "lease-close-wins" });

    await expect(prepareBrowserAllocation(entry.params)).rejects.toThrow(
      "connection closed during startup",
    );
    expect(entry.cancel).toHaveBeenCalledOnce();
    expect(entry.closeDurable).toHaveBeenCalledOnce();
    expect(entry.cancel.mock.invocationCallOrder[0]).toBeLessThan(
      entry.closeDurable.mock.invocationCallOrder[0]!,
    );
    lease.release();
    await closing;
  });

  it("cancels without closing resumed durable state after connection close wins", async () => {
    const lease = acquireBrowserCreationLease("lease-close-wins");
    const closing = cleanupTalkConnection("lease-close-wins", { warn: vi.fn() });
    const entry = createAllocation({
      connId: "lease-close-wins",
      durableState: "existing",
    });

    await expect(prepareBrowserAllocation(entry.params)).rejects.toThrow(
      "connection closed during startup",
    );
    expect(entry.cancel).toHaveBeenCalledOnce();
    expect(entry.closeDurable).not.toHaveBeenCalled();
    lease.release();
    await closing;
  });

  it("uses allocation cleanup after publication wins the connection race", async () => {
    const lease = acquireBrowserCreationLease("lease-publication-wins");
    const entry = createAllocation({ connId: "lease-publication-wins" });
    const allocation = await prepareBrowserAllocation(entry.params);
    commitBrowserAllocation(identity(allocation));
    lease.assertActive();
    lease.release();

    await cleanupTalkConnection("lease-publication-wins", { warn: vi.fn() });

    expect(entry.cancel).toHaveBeenCalledOnce();
    expect(entry.closeDurable).toHaveBeenCalledOnce();
  });

  it("closes only newly-created durable state when the initial candidate aborts", async () => {
    const created = createAllocation();
    const createdAllocation = await prepareBrowserAllocation(created.params);
    await expect(abortBrowserAllocation(identity(createdAllocation))).resolves.toEqual({
      state: "aborted",
    });
    expect(created.cancel).toHaveBeenCalledOnce();
    expect(created.closeDurable).toHaveBeenCalledOnce();

    const resumed = createAllocation({ voiceSessionId: "voice-resumed", durableState: "existing" });
    const resumedAllocation = await prepareBrowserAllocation(resumed.params);
    await abortBrowserAllocation(identity(resumedAllocation));
    expect(resumed.cancel).toHaveBeenCalledOnce();
    expect(resumed.closeDurable).not.toHaveBeenCalled();
  });

  it("settles an ephemeral allocation exactly once without closing durable state", async () => {
    const entry = createAllocation({ durableState: "ephemeral" });
    const allocation = await prepareBrowserAllocation(entry.params);

    await closeBrowserAllocation(identity(allocation));
    await closeBrowserAllocation(identity(allocation));

    expect(entry.cancel).toHaveBeenCalledOnce();
    expect(entry.closeDurable).not.toHaveBeenCalled();
  });

  it("promotes same-identity ownership to created before abort and disconnect settle", async () => {
    const ephemeral = createAllocation({ durableState: "ephemeral" });
    await prepareBrowserAllocation(ephemeral.params);
    const created = createAllocation({ connId: "conn-2" });
    const allocation = await prepareBrowserAllocation(created.params);

    await Promise.all([
      abortBrowserAllocation(identity(allocation)),
      cleanupTalkConnection("conn-1", { warn: vi.fn() }),
    ]);

    expect(ephemeral.cancel).toHaveBeenCalledOnce();
    expect(created.cancel).toHaveBeenCalledOnce();
    expect(ephemeral.closeDurable).not.toHaveBeenCalled();
    expect(created.closeDurable).toHaveBeenCalledOnce();
  });

  it("publishes a replacement before cancelling the old committed transport", async () => {
    const first = createAllocation();
    const second = createAllocation({ connId: "conn-2" });
    const committed = await prepareBrowserAllocation(first.params);
    expect(commitBrowserAllocation(identity(committed))).toEqual({ state: "committed" });
    const candidate = await prepareBrowserAllocation(second.params);

    expect(commitBrowserAllocation(identity(candidate))).toEqual({ state: "committed" });
    expect(commitBrowserAllocation(identity(candidate))).toEqual({ state: "committed" });
    await vi.waitFor(() => expect(first.cancel).toHaveBeenCalledOnce());
    expect(first.closeDurable).not.toHaveBeenCalled();
    expect(second.cancel).not.toHaveBeenCalled();
  });

  it("fences mutations to the connection that owns the allocation", async () => {
    const entry = createAllocation();
    const allocation = await prepareBrowserAllocation(entry.params);

    expect(() => commitBrowserAllocation(identity(allocation, "conn-2"))).toThrow(
      "another connection",
    );
    await expect(abortBrowserAllocation(identity(allocation, "conn-2"))).rejects.toThrow(
      "another connection",
    );
    expect(entry.cancel).not.toHaveBeenCalled();
  });

  it("resolves a missing allocation id only to its same-connection legacy active slot", async () => {
    const legacy = createAllocation({ legacyAutoCommit: true });
    const allocation = await prepareBrowserAllocation(legacy.params);
    commitBrowserAllocation(identity(allocation));

    await expect(
      closeBrowserAllocation({
        agentId: allocation.agentId,
        sessionKey: allocation.sessionKey,
        voiceSessionId: allocation.voiceSessionId,
        connId: "conn-2",
      }),
    ).resolves.toBe("settled");
    expect(legacy.cancel).not.toHaveBeenCalled();
    expect(legacy.closeDurable).not.toHaveBeenCalled();

    await expect(
      closeBrowserAllocation({
        agentId: allocation.agentId,
        sessionKey: allocation.sessionKey,
        voiceSessionId: allocation.voiceSessionId,
        connId: allocation.connId,
      }),
    ).resolves.toBe("settled");
    expect(legacy.cancel).toHaveBeenCalledOnce();
    expect(legacy.closeDurable).toHaveBeenCalledOnce();
  });

  it("does not resolve a missing allocation id to a modern active slot", async () => {
    const modern = createAllocation();
    const allocation = await prepareBrowserAllocation(modern.params);
    commitBrowserAllocation(identity(allocation));

    await expect(
      closeBrowserAllocation({
        agentId: allocation.agentId,
        sessionKey: allocation.sessionKey,
        voiceSessionId: allocation.voiceSessionId,
        connId: allocation.connId,
      }),
    ).resolves.toBe("settled");
    expect(modern.cancel).not.toHaveBeenCalled();
    expect(modern.closeDurable).not.toHaveBeenCalled();
  });

  it("preserves durable-only fallback when no allocation owner exists", async () => {
    await expect(
      closeBrowserAllocation({
        agentId: "main",
        sessionKey: "agent:main:main",
        voiceSessionId: "voice-missing",
        connId: "conn-1",
      }),
    ).resolves.toBe("ownerless-legacy");
  });

  it("delegates ownerless exact close to the durable allocation claim", async () => {
    await expect(
      closeBrowserAllocation({
        agentId: "main",
        sessionKey: "agent:main:main",
        voiceSessionId: "voice-missing",
        allocationId: "allocation-restart",
        connId: "conn-1",
      }),
    ).resolves.toBe("ownerless-exact");
  });

  it("delegates an unmatched exact close without disturbing a live owner", async () => {
    const entry = createAllocation({ allocationId: "allocation-live" });
    const allocation = await prepareBrowserAllocation(entry.params);
    commitBrowserAllocation(identity(allocation));

    await expect(
      closeBrowserAllocation({
        ...identity(allocation),
        allocationId: "allocation-stale",
      }),
    ).resolves.toBe("ownerless-exact");
    expect(entry.cancel).not.toHaveBeenCalled();
    expect(entry.closeDurable).not.toHaveBeenCalled();
  });

  it("claims durable ownership before publishing a replacement", async () => {
    const first = createAllocation({ allocationId: "allocation-1" });
    const second = createAllocation({ allocationId: "allocation-2", connId: "conn-2" });
    const active = await prepareBrowserAllocation(first.params);
    commitBrowserAllocation(identity(active));
    const replacement = await prepareBrowserAllocation(second.params);
    second.claimDurable.mockReturnValueOnce(false);

    expect(() => commitBrowserAllocation(identity(replacement))).toThrow(
      "browser allocation changed",
    );
    expect(first.cancel).not.toHaveBeenCalled();
    expect(second.cancel).not.toHaveBeenCalled();
  });

  it("holds terminal ownership until the client acknowledges close", async () => {
    const entry = createAllocation();
    const allocation = await prepareBrowserAllocation(entry.params);
    commitBrowserAllocation(identity(allocation));

    terminateBrowserAllocation(allocation, { outcome: "error", message: "sideband failed" });
    expect(entry.retireEffects).toHaveBeenCalledOnce();
    expect(entry.broadcast).toHaveBeenCalledWith(
      "talk.client.allocation.terminal",
      {
        allocationId: allocation.allocationId,
        sessionKey: allocation.sessionKey,
        voiceSessionId: allocation.voiceSessionId,
        outcome: "error",
        message: "sideband failed",
      },
      new Set(["conn-1"]),
    );
    expect(commitBrowserAllocation(identity(allocation))).toEqual({
      state: "terminal",
      terminal: { outcome: "error", message: "sideband failed" },
    });
    expect(entry.closeDurable).not.toHaveBeenCalled();

    await closeBrowserAllocation(identity(allocation));
    await closeBrowserAllocation(identity(allocation));
    expect(entry.retireEffects).toHaveBeenCalledOnce();
    expect(entry.closeDurable).toHaveBeenCalledOnce();
  });

  it("retains a released tombstone for exact durable-close retry without recancelling", async () => {
    vi.useFakeTimers();
    const entry = createAllocation();
    entry.closeDurable.mockRejectedValue(new Error("storage busy"));
    const allocation = await prepareBrowserAllocation(entry.params);
    commitBrowserAllocation(identity(allocation));

    const firstClose = expect(closeBrowserAllocation(identity(allocation))).rejects.toThrow(
      "storage busy",
    );
    await vi.advanceTimersByTimeAsync(2_500);
    await firstClose;
    expect(entry.cancel).toHaveBeenCalledOnce();
    expect(entry.closeDurable).toHaveBeenCalledTimes(3);

    entry.closeDurable.mockResolvedValue(undefined);
    await expect(closeBrowserAllocation(identity(allocation))).resolves.toBe("settled");
    expect(entry.cancel).toHaveBeenCalledOnce();
    expect(entry.closeDurable).toHaveBeenCalledTimes(4);
  });

  it("retries failed prepublication close and later accepts a successor without recancelling", async () => {
    vi.useFakeTimers();
    const lease = acquireBrowserCreationLease("lease-close-wins");
    const closing = cleanupTalkConnection("lease-close-wins", { warn: vi.fn() });
    const entry = createAllocation({ connId: "lease-close-wins" });
    entry.closeDurable.mockRejectedValue(new Error("storage busy"));

    const preparing = expect(prepareBrowserAllocation(entry.params)).rejects.toThrow(
      "storage busy",
    );
    await vi.advanceTimersByTimeAsync(2_500);
    await preparing;
    expect(entry.cancel).toHaveBeenCalledOnce();
    expect(entry.closeDurable).toHaveBeenCalledTimes(3);
    lease.release();
    await closing;

    entry.closeDurable.mockResolvedValue(undefined);
    const successor = createAllocation({ connId: "conn-2" });
    const allocation = await prepareBrowserAllocation(successor.params);
    await abortBrowserAllocation(identity(allocation));

    expect(entry.cancel).toHaveBeenCalledOnce();
    expect(successor.cancel).toHaveBeenCalledOnce();
    expect(entry.closeDurable).toHaveBeenCalledTimes(4);
    expect(successor.closeDurable).not.toHaveBeenCalled();
  });

  it("shares provider retirement before concurrent close and disconnect finish", async () => {
    let finishCancel!: () => void;
    const cancelPending = new Promise<void>((resolve) => {
      finishCancel = resolve;
    });
    const entry = createAllocation();
    entry.cancel.mockImplementationOnce(async () => await cancelPending);
    const allocation = await prepareBrowserAllocation(entry.params);
    commitBrowserAllocation(identity(allocation));

    const close = closeBrowserAllocation(identity(allocation));
    const disconnect = cleanupTalkConnection("conn-1", { warn: vi.fn() });
    await vi.waitFor(() => expect(entry.cancel).toHaveBeenCalledOnce());
    expect(entry.closeDurable).not.toHaveBeenCalled();

    finishCancel();
    await Promise.all([close, disconnect]);

    expect(entry.cancel).toHaveBeenCalledOnce();
    expect(entry.closeDurable).toHaveBeenCalledOnce();
  });

  it("drains a superseded candidate before abort closes durable state", async () => {
    let finishSupersededCancel!: () => void;
    const supersededCancel = new Promise<void>((resolve) => {
      finishSupersededCancel = resolve;
    });
    const first = createAllocation();
    first.cancel.mockImplementationOnce(async () => await supersededCancel);
    await prepareBrowserAllocation(first.params);
    const second = createAllocation({ connId: "conn-2" });
    const candidate = await prepareBrowserAllocation(second.params);

    const aborting = abortBrowserAllocation(identity(candidate));
    await vi.waitFor(() => {
      expect(first.cancel).toHaveBeenCalledOnce();
      expect(second.cancel).toHaveBeenCalledOnce();
    });
    expect(first.closeDurable).not.toHaveBeenCalled();

    finishSupersededCancel();
    await expect(aborting).resolves.toEqual({ state: "aborted" });

    expect(first.closeDurable).toHaveBeenCalledOnce();
    expect(second.closeDurable).not.toHaveBeenCalled();
  });

  it("drains superseded active retirement before concurrent close and disconnect", async () => {
    let finishSupersededCancel!: () => void;
    const supersededCancel = new Promise<void>((resolve) => {
      finishSupersededCancel = resolve;
    });
    const first = createAllocation();
    first.cancel.mockImplementationOnce(async () => await supersededCancel);
    const active = await prepareBrowserAllocation(first.params);
    commitBrowserAllocation(identity(active));
    const second = createAllocation({ connId: "conn-2" });
    const replacement = await prepareBrowserAllocation(second.params);
    commitBrowserAllocation(identity(replacement));

    const closing = closeBrowserAllocation(identity(replacement));
    const disconnecting = cleanupTalkConnection("conn-2", { warn: vi.fn() });
    await vi.waitFor(() => {
      expect(first.cancel).toHaveBeenCalledOnce();
      expect(second.cancel).toHaveBeenCalledOnce();
    });
    expect(first.closeDurable).not.toHaveBeenCalled();

    finishSupersededCancel();
    await Promise.all([closing, disconnecting]);

    expect(first.closeDurable).not.toHaveBeenCalled();
    expect(second.closeDurable).toHaveBeenCalledOnce();
  });

  it("retains disconnected ownership when durable close needs an exact retry", async () => {
    vi.useFakeTimers();
    const entry = createAllocation();
    entry.closeDurable.mockRejectedValue(new Error("storage busy"));
    const allocation = await prepareBrowserAllocation(entry.params);
    commitBrowserAllocation(identity(allocation));

    const disconnect = cleanupTalkConnection("conn-1", { warn: vi.fn() });
    await vi.advanceTimersByTimeAsync(2_500);
    await disconnect;
    entry.closeDurable.mockResolvedValue(undefined);
    await expect(closeBrowserAllocation(identity(allocation))).resolves.toBe("settled");

    expect(entry.params.warn).toHaveBeenCalledOnce();
    expect(entry.cancel).toHaveBeenCalledOnce();
    expect(entry.closeDurable).toHaveBeenCalledTimes(4);
  });

  it("rejects a new allocation while durable close owns the session identity", async () => {
    let resolveClose!: () => void;
    const closePending = new Promise<void>((resolve) => {
      resolveClose = resolve;
    });
    const entry = createAllocation();
    entry.closeDurable.mockImplementationOnce(async () => await closePending);
    const allocation = await prepareBrowserAllocation(entry.params);
    commitBrowserAllocation(identity(allocation));

    const closing = closeBrowserAllocation(identity(allocation));
    await vi.waitFor(() => expect(entry.closeDurable).toHaveBeenCalledOnce());
    const successor = createAllocation({ connId: "conn-2" });
    await expect(prepareBrowserAllocation(successor.params)).rejects.toThrow(
      "browser Talk session is closing",
    );
    expect(successor.cancel).toHaveBeenCalledOnce();

    resolveClose();
    await expect(closing).resolves.toBe("settled");
    expect(entry.closeDurable).toHaveBeenCalledOnce();
  });

  it("keeps the committed transport when its candidate terminates", async () => {
    const first = createAllocation();
    const second = createAllocation({ connId: "conn-2" });
    const committed = await prepareBrowserAllocation(first.params);
    commitBrowserAllocation(identity(committed));
    const candidate = await prepareBrowserAllocation(second.params);

    terminateBrowserAllocation(candidate, { outcome: "completed" });
    await closeBrowserAllocation(identity(candidate));

    expect(second.broadcast).toHaveBeenCalledOnce();
    expect(first.cancel).not.toHaveBeenCalled();
    expect(first.closeDurable).not.toHaveBeenCalled();
    await closeBrowserAllocation(identity(committed));
    expect(first.closeDurable).toHaveBeenCalledOnce();
  });

  it("bounds legacy terminal cleanup without sending the incompatible event", async () => {
    vi.useFakeTimers();
    const legacy = createAllocation();
    const allocation = await prepareBrowserAllocation(legacy.params);
    commitBrowserAllocation(identity(allocation));

    terminateBrowserAllocation(allocation, { outcome: "completed" });
    expect(legacy.broadcast).toHaveBeenCalledOnce();
    expect(legacy.closeDurable).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(34_999);
    expect(legacy.closeDurable).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(legacy.closeDurable).toHaveBeenCalledOnce();
  });

  it("preserves resumed durable state only until an allocation has committed", async () => {
    const activeEntry = createAllocation({ durableState: "existing" });
    const candidateEntry = createAllocation({ durableState: "existing", connId: "conn-2" });
    const active = await prepareBrowserAllocation(activeEntry.params);
    commitBrowserAllocation(identity(active));
    const candidate = await prepareBrowserAllocation(candidateEntry.params);

    await closeBrowserAllocation(identity(active));
    expect(activeEntry.closeDurable).not.toHaveBeenCalled();
    await abortBrowserAllocation(identity(candidate));

    expect(activeEntry.cancel).toHaveBeenCalledOnce();
    expect(candidateEntry.cancel).toHaveBeenCalledOnce();
    expect(activeEntry.closeDurable).toHaveBeenCalledOnce();
  });

  it("rejects commit after a released candidate is retained for close retry", async () => {
    vi.useFakeTimers();
    const entry = createAllocation();
    entry.closeDurable.mockRejectedValue(new Error("storage busy"));
    const allocation = await prepareBrowserAllocation(entry.params);
    const aborting = expect(abortBrowserAllocation(identity(allocation))).rejects.toThrow(
      "storage busy",
    );
    await vi.advanceTimersByTimeAsync(2_500);
    await aborting;

    expect(() => commitBrowserAllocation(identity(allocation))).toThrow(
      "browser Talk allocation is no longer a candidate",
    );
    entry.closeDurable.mockResolvedValue(undefined);
    await closeBrowserAllocation(identity(allocation));
  });

  it("preserves durable state while a successor on another connection remains viable", async () => {
    const first = createAllocation();
    const successor = createAllocation({ connId: "conn-2" });
    const committed = await prepareBrowserAllocation(first.params);
    commitBrowserAllocation(identity(committed));
    await prepareBrowserAllocation(successor.params);

    await cleanupTalkConnection("conn-1", { warn: vi.fn() });

    expect(first.cancel).toHaveBeenCalledOnce();
    expect(first.closeDurable).not.toHaveBeenCalled();
    await cleanupTalkConnection("conn-2", { warn: vi.fn() });
    expect(successor.cancel).toHaveBeenCalledOnce();
    expect(first.closeDurable).toHaveBeenCalledOnce();
  });

  it("drains allocations through the connection cleanup registry", async () => {
    const entry = createAllocation({ connId: "disconnect" });
    const allocation = await prepareBrowserAllocation(entry.params);
    commitBrowserAllocation(identity(allocation));
    const log = { warn: vi.fn() };

    await cleanupTalkConnection("disconnect", log);

    expect(entry.cancel).toHaveBeenCalledOnce();
    expect(entry.closeDurable).toHaveBeenCalledOnce();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("closes shared durable state once when committed and candidate disconnect together", async () => {
    const committedEntry = createAllocation();
    const candidateEntry = createAllocation();
    const committed = await prepareBrowserAllocation(committedEntry.params);
    commitBrowserAllocation(identity(committed));
    await prepareBrowserAllocation(candidateEntry.params);

    await cleanupTalkConnection("conn-1", { warn: vi.fn() });

    expect(committedEntry.cancel).toHaveBeenCalledOnce();
    expect(candidateEntry.cancel).toHaveBeenCalledOnce();
    expect(committedEntry.closeDurable).toHaveBeenCalledOnce();
    expect(candidateEntry.closeDurable).not.toHaveBeenCalled();
  });
});
