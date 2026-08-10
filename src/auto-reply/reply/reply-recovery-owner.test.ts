import { afterEach, describe, expect, it, vi } from "vitest";
import type { MainSessionRecoveryOwnerLease } from "../../agents/main-session-recovery-store.js";
import type { InternalSessionEntry } from "../../config/sessions.js";
import { abortSessionRunTargetWithOutcome } from "./abort.js";
import {
  runReplyRecoveryUserAbort,
  setReplyRecoveryOwner,
  waitForReplyRecoveryAbortPersistence,
} from "./reply-recovery-owner.js";
import { createReplyOperation } from "./reply-run-registry.js";
import { testing as replyRunTesting } from "./reply-run-registry.test-support.js";

const recoveryMocks = vi.hoisted(() => ({
  abortOwner: vi.fn(),
  abortRun: vi.fn(),
  repair: vi.fn(),
}));

vi.mock("../../agents/main-session-recovery-lifecycle.js", () => ({
  repairMainSessionRecoveryMutation: recoveryMocks.repair,
}));

vi.mock("../../agents/main-session-recovery-store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/main-session-recovery-store.js")>()),
  abortMainSessionRecoveryOwner: recoveryMocks.abortOwner,
  abortMainSessionRecoveryRun: recoveryMocks.abortRun,
}));

afterEach(() => {
  replyRunTesting.resetReplyRunRegistry();
  recoveryMocks.abortOwner.mockReset();
  recoveryMocks.abortRun.mockReset();
  recoveryMocks.repair.mockReset();
});

describe("reply recovery owner", () => {
  it("keeps owner release fenced until deferred abort persistence succeeds", async () => {
    let deferredSuccess:
      | ((result: { kind: "applied"; entry: InternalSessionEntry; sessionKey: string }) => void)
      | undefined;
    recoveryMocks.repair.mockImplementation(async (params) => {
      deferredSuccess = params.onDeferredSuccess;
      params.onError(new Error("temporary writer outage"));
      return undefined;
    });
    const operation = createReplyOperation({
      sessionKey: "agent:main:telegram:topic:abort-retry",
      sessionId: "session-abort-retry",
      resetTriggered: false,
    });
    operation.attachBackend({
      kind: "embedded",
      runId: "run-abort-retry",
      cancel: () => {},
    });
    const lease: MainSessionRecoveryOwnerLease = {
      cycleId: "cycle-abort-retry",
      lifecycleGeneration: "generation-abort-retry",
      claimId: "claim-abort-retry",
      sessionId: "session-abort-retry",
      sessionKey: "agent:main:telegram:topic:abort-retry",
      storePath: "/tmp/abort-retry.sessions.json",
    };
    setReplyRecoveryOwner(operation, lease);

    await expect(
      runReplyRecoveryUserAbort({
        operation,
        abort: () => ({ active: true, aborted: true }),
        logLabel: operation.key,
      }),
    ).resolves.toEqual({
      active: true,
      aborted: true,
      recoveryPersistenceErrors: ["temporary writer outage"],
    });
    let released = false;
    const releaseWait = waitForReplyRecoveryAbortPersistence(operation).then(() => {
      released = true;
    });
    await Promise.resolve();
    expect(released).toBe(false);

    const entry: InternalSessionEntry = {
      sessionId: lease.sessionId,
      status: "killed",
      abortedLastRun: true,
      updatedAt: 10,
    };
    deferredSuccess?.({
      kind: "applied",
      entry,
      sessionKey: lease.sessionKey,
    });
    await releaseWait;
    expect(released).toBe(true);
  });

  it("terminalizes every recovery owner attached to one operation", async () => {
    const operation = createReplyOperation({
      sessionKey: "agent:main:telegram:topic:multi-owner",
      sessionId: "session-multi-owner",
      resetTriggered: false,
    });
    operation.attachBackend({
      kind: "embedded",
      runId: "run-multi-owner",
      cancel: () => {},
    });
    operation.setPhase("running");
    const leases: MainSessionRecoveryOwnerLease[] = [
      {
        cycleId: "cycle-source",
        lifecycleGeneration: "generation-source",
        claimId: "claim-source",
        sessionId: "session-source",
        sessionKey: "agent:main:telegram:slash:multi-owner-source",
        storePath: "/tmp/multi-owner.sessions.json",
      },
      {
        cycleId: "cycle-target",
        lifecycleGeneration: "generation-target",
        claimId: "claim-target",
        sessionId: "session-target",
        sessionKey: "agent:main:telegram:group:multi-owner-target",
        storePath: "/tmp/multi-owner.sessions.json",
      },
    ];
    for (const lease of leases) {
      setReplyRecoveryOwner(operation, lease);
    }
    recoveryMocks.abortOwner.mockImplementation(async (lease) => ({
      kind: "applied",
      entry: {
        sessionId: lease.sessionId,
        status: "killed",
        abortedLastRun: true,
        updatedAt: 10,
      },
      sessionKey: lease.sessionKey,
    }));
    recoveryMocks.repair.mockImplementation(async (params) => await params.mutation());

    await expect(
      runReplyRecoveryUserAbort({
        operation,
        abort: () =>
          abortSessionRunTargetWithOutcome({
            key: operation.key,
            sessionId: operation.sessionId,
          }),
        logLabel: operation.key,
      }),
    ).resolves.toMatchObject({
      active: true,
      aborted: true,
      recoveries: leases.map((lease) => ({
        entry: {
          sessionId: lease.sessionId,
          status: "killed",
          abortedLastRun: true,
        },
        sessionKey: lease.sessionKey,
      })),
    });
    expect(recoveryMocks.abortOwner.mock.calls).toEqual(
      leases.map((lease) => [lease, "run-multi-owner"]),
    );
    await expect(waitForReplyRecoveryAbortPersistence(operation)).resolves.toBeUndefined();
  });

  it("settles accepted abort persistence when backend cancellation throws", async () => {
    const operation = createReplyOperation({
      sessionKey: "agent:main:telegram:topic:abort-cancel-throws",
      sessionId: "session-abort-cancel-throws",
      resetTriggered: false,
    });
    operation.attachBackend({
      kind: "embedded",
      runId: "run-abort-cancel-throws",
      cancel: () => {
        throw new Error("cancel failed");
      },
    });
    operation.setPhase("running");
    const lease: MainSessionRecoveryOwnerLease = {
      cycleId: "cycle-abort-cancel-throws",
      lifecycleGeneration: "generation-abort-cancel-throws",
      claimId: "claim-abort-cancel-throws",
      sessionId: operation.sessionId,
      sessionKey: operation.key,
      storePath: "/tmp/abort-cancel-throws.sessions.json",
    };
    setReplyRecoveryOwner(operation, lease);
    const entry: InternalSessionEntry = {
      sessionId: lease.sessionId,
      status: "killed",
      abortedLastRun: true,
      updatedAt: 10,
    };
    recoveryMocks.abortOwner.mockResolvedValue({
      kind: "applied",
      entry,
      sessionKey: lease.sessionKey,
    });
    recoveryMocks.repair.mockImplementation(async (params) => await params.mutation());

    await expect(
      runReplyRecoveryUserAbort({
        operation,
        abort: () =>
          abortSessionRunTargetWithOutcome({
            key: operation.key,
            sessionId: operation.sessionId,
          }),
        logLabel: operation.key,
      }),
    ).rejects.toThrow("cancel failed");
    expect(recoveryMocks.abortOwner).toHaveBeenCalledWith(lease, "run-abort-cancel-throws");
    await expect(waitForReplyRecoveryAbortPersistence(operation)).resolves.toBeUndefined();
  });

  it("terminalizes an accepted operationless recovery run by exact identity", async () => {
    const recoveryRun = {
      lifecycleGeneration: "generation-operationless",
      runId: "run-operationless",
      sessionId: "session-operationless",
      sessionKey: "agent:main:telegram:topic:operationless",
      storePath: "/tmp/operationless.sessions.json",
    };
    const entry: InternalSessionEntry = {
      sessionId: recoveryRun.sessionId,
      status: "killed",
      abortedLastRun: true,
      updatedAt: 10,
    };
    recoveryMocks.abortRun.mockResolvedValue({
      kind: "applied",
      entry,
      sessionKey: recoveryRun.sessionKey,
    });
    recoveryMocks.repair.mockImplementation(async (params) => await params.mutation());

    await expect(
      runReplyRecoveryUserAbort({
        operation: undefined,
        recoveryRun,
        abort: async () => ({ active: true, aborted: true }),
        logLabel: recoveryRun.sessionKey,
      }),
    ).resolves.toEqual({
      active: true,
      aborted: true,
      recoveries: [{ kind: "applied", entry, sessionKey: recoveryRun.sessionKey }],
    });
    expect(recoveryMocks.abortRun).toHaveBeenCalledWith(recoveryRun);
  });

  it("does not terminalize an operationless recovery run when cancellation is rejected", async () => {
    const recoveryRun = {
      lifecycleGeneration: "generation-rejected",
      runId: "run-rejected",
      sessionId: "session-rejected",
      sessionKey: "agent:main:telegram:topic:rejected",
      storePath: "/tmp/rejected.sessions.json",
    };

    await expect(
      runReplyRecoveryUserAbort({
        operation: undefined,
        recoveryRun,
        abort: () => ({ active: true, aborted: false }),
        logLabel: recoveryRun.sessionKey,
      }),
    ).resolves.toEqual({ active: true, aborted: false });
    expect(recoveryMocks.abortRun).not.toHaveBeenCalled();
    expect(recoveryMocks.repair).not.toHaveBeenCalled();
  });

  it("reports operationless persistence failure as retryable caller evidence", async () => {
    const recoveryRun = {
      lifecycleGeneration: "generation-operationless-failure",
      runId: "run-operationless-failure",
      sessionId: "session-operationless-failure",
      sessionKey: "agent:main:telegram:topic:operationless-failure",
      storePath: "/tmp/operationless-failure.sessions.json",
    };
    recoveryMocks.repair.mockImplementation(async (params) => {
      params.onError(new Error("temporary writer outage"));
      return undefined;
    });

    await expect(
      runReplyRecoveryUserAbort({
        operation: undefined,
        recoveryRun,
        abort: () => ({ active: true, aborted: true }),
        logLabel: recoveryRun.sessionKey,
      }),
    ).resolves.toEqual({
      active: true,
      aborted: true,
      recoveryPersistenceErrors: ["temporary writer outage"],
    });
  });
});
