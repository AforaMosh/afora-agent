import { afterEach, describe, expect, it, vi } from "vitest";
import type { MainSessionRecoveryOwnerLease } from "../../agents/main-session-recovery-store.js";
import type { InternalSessionEntry } from "../../config/sessions.js";
import { abortSessionRunTarget } from "./abort.js";
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
        abort: () => ({ active: true, aborted: operation.abortByUser() }),
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

  it("keeps a same-session successor fenced while an exact older owner persists", async () => {
    let deferredSuccess:
      | ((result: { kind: "applied"; entry: InternalSessionEntry; sessionKey: string }) => void)
      | undefined;
    recoveryMocks.repair.mockImplementation(async (params) => {
      deferredSuccess = params.onDeferredSuccess;
      params.onError(new Error("temporary older-owner writer outage"));
      return undefined;
    });
    const sessionId = "session-two-operation-abort-retry";
    const operation = createReplyOperation({
      sessionKey: "agent:main:telegram:topic:older-owner",
      sessionId,
      resetTriggered: false,
    });
    operation.attachBackend({
      kind: "embedded",
      runId: "run-two-operation-older",
      cancel: () => {},
    });
    const successor = createReplyOperation({
      sessionKey: "agent:main:telegram:topic:successor-owner",
      sessionId,
      resetTriggered: false,
    });
    const lease: MainSessionRecoveryOwnerLease = {
      cycleId: "cycle-two-operation-abort-retry",
      lifecycleGeneration: "generation-two-operation-abort-retry",
      claimId: "claim-two-operation-abort-retry",
      sessionId,
      sessionKey: operation.key,
      storePath: "/tmp/two-operation-abort-retry.sessions.json",
    };
    setReplyRecoveryOwner(operation, lease);

    await expect(
      runReplyRecoveryUserAbort({
        operation,
        barrierOperation: successor,
        abort: () => ({ active: true, aborted: operation.abortByUser() }),
        logLabel: operation.key,
      }),
    ).resolves.toEqual({
      active: true,
      aborted: true,
      recoveryPersistenceErrors: ["temporary older-owner writer outage"],
    });

    let operationReleased = false;
    let successorReleased = false;
    const releaseWait = Promise.all([
      waitForReplyRecoveryAbortPersistence(operation).then(() => {
        operationReleased = true;
      }),
      waitForReplyRecoveryAbortPersistence(successor).then(() => {
        successorReleased = true;
      }),
    ]);
    await Promise.resolve();
    expect(operationReleased).toBe(false);
    expect(successorReleased).toBe(false);

    deferredSuccess?.({
      kind: "applied",
      entry: {
        sessionId,
        status: "killed",
        abortedLastRun: true,
        updatedAt: 10,
      },
      sessionKey: operation.key,
    });
    await releaseWait;
    expect(operationReleased).toBe(true);
    expect(successorReleased).toBe(true);
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
      abortSessionRunTarget({
        key: operation.key,
        sessionId: operation.sessionId,
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

  it("does not terminalize an operation owner when only unrelated work was aborted", async () => {
    const operation = createReplyOperation({
      sessionKey: "agent:main:telegram:topic:unrelated-abort",
      sessionId: "session-unrelated-abort",
      resetTriggered: false,
    });
    const lease: MainSessionRecoveryOwnerLease = {
      cycleId: "cycle-unrelated-abort",
      lifecycleGeneration: "generation-unrelated-abort",
      claimId: "claim-unrelated-abort",
      sessionId: operation.sessionId,
      sessionKey: operation.key,
      storePath: "/tmp/unrelated-abort.sessions.json",
    };
    setReplyRecoveryOwner(operation, lease);

    await expect(
      runReplyRecoveryUserAbort({
        operation,
        abort: () => ({ active: true, aborted: true }),
        logLabel: operation.key,
      }),
    ).resolves.toEqual({ active: true, aborted: true });
    expect(operation.result).toBeNull();
    expect(recoveryMocks.abortOwner).not.toHaveBeenCalled();
    expect(recoveryMocks.repair).not.toHaveBeenCalled();
    await expect(waitForReplyRecoveryAbortPersistence(operation)).resolves.toBeUndefined();
    operation.complete();
  });

  it("terminalizes distinct accepted operation and embedded recovery identities", async () => {
    const operation = createReplyOperation({
      sessionKey: "agent:main:telegram:topic:dual-recovery-abort",
      sessionId: "session-dual-recovery-abort",
      resetTriggered: false,
    });
    operation.attachBackend({
      kind: "embedded",
      runId: "run-dual-recovery-successor",
      cancel: () => {},
    });
    operation.setPhase("running");
    const lease: MainSessionRecoveryOwnerLease = {
      cycleId: "cycle-dual-recovery-successor",
      lifecycleGeneration: "generation-dual-recovery",
      claimId: "claim-dual-recovery-successor",
      sessionId: operation.sessionId,
      sessionKey: operation.key,
      storePath: "/tmp/dual-recovery.sessions.json",
      runId: "run-dual-recovery-successor",
    };
    const recoveryRun = {
      lifecycleGeneration: "generation-dual-recovery",
      runId: "run-dual-recovery-older",
      sessionId: operation.sessionId,
      sessionKey: operation.key,
      storePath: lease.storePath,
    };
    setReplyRecoveryOwner(operation, lease);
    recoveryMocks.abortOwner.mockResolvedValue({
      kind: "applied",
      entry: {
        sessionId: operation.sessionId,
        status: "running",
        abortedLastRun: true,
        updatedAt: 10,
      },
      sessionKey: operation.key,
    });
    recoveryMocks.abortRun.mockResolvedValue({
      kind: "applied",
      entry: {
        sessionId: operation.sessionId,
        status: "killed",
        abortedLastRun: true,
        updatedAt: 11,
      },
      sessionKey: operation.key,
    });
    recoveryMocks.repair.mockImplementation(async (params) => await params.mutation());
    let recoveryRunAborted = false;

    await expect(
      runReplyRecoveryUserAbort({
        operation,
        recoveryRun,
        didAbortRecoveryRun: () => recoveryRunAborted,
        abort: () => {
          const aborted = operation.abortByUser();
          recoveryRunAborted = true;
          return { active: true, aborted };
        },
        logLabel: operation.key,
      }),
    ).resolves.toMatchObject({
      active: true,
      aborted: true,
      recoveries: [{ kind: "applied" }, { kind: "applied" }],
    });
    expect(recoveryMocks.abortOwner).toHaveBeenCalledWith(lease, "run-dual-recovery-successor");
    expect(recoveryMocks.abortRun).toHaveBeenCalledWith(recoveryRun);
    await expect(waitForReplyRecoveryAbortPersistence(operation)).resolves.toBeUndefined();
  });

  it("keeps successor release fenced until distinct recovery persistence succeeds", async () => {
    let deferredSuccess:
      | ((result: { kind: "applied"; entry: InternalSessionEntry; sessionKey: string }) => void)
      | undefined;
    recoveryMocks.repair.mockImplementation(async (params) => {
      deferredSuccess = params.onDeferredSuccess;
      params.onError(new Error("temporary distinct writer outage"));
      return undefined;
    });
    const operation = createReplyOperation({
      sessionKey: "agent:main:telegram:topic:distinct-abort-retry",
      sessionId: "session-distinct-abort-retry",
      resetTriggered: false,
    });
    operation.attachBackend({
      kind: "embedded",
      runId: "run-distinct-abort-successor",
      cancel: () => {},
    });
    const recoveryRun = {
      lifecycleGeneration: operation.lifecycleGeneration!,
      runId: "run-distinct-abort-older",
      sessionId: operation.sessionId,
      sessionKey: operation.key,
      storePath: "/tmp/distinct-abort-retry.sessions.json",
    };
    let recoveryRunAborted = false;

    await expect(
      runReplyRecoveryUserAbort({
        operation: undefined,
        barrierOperation: operation,
        recoveryRun,
        didAbortRecoveryRun: () => recoveryRunAborted,
        abort: () => {
          recoveryRunAborted = true;
          return { active: true, aborted: true };
        },
        logLabel: operation.key,
      }),
    ).resolves.toEqual({
      active: true,
      aborted: true,
      recoveryPersistenceErrors: ["temporary distinct writer outage"],
    });
    expect(operation.result).toBeNull();
    let released = false;
    const releaseWait = waitForReplyRecoveryAbortPersistence(operation).then(() => {
      released = true;
    });
    await Promise.resolve();
    expect(released).toBe(false);

    deferredSuccess?.({
      kind: "applied",
      entry: {
        sessionId: recoveryRun.sessionId,
        status: "killed",
        abortedLastRun: true,
        updatedAt: 10,
      },
      sessionKey: recoveryRun.sessionKey,
    });
    await releaseWait;
    expect(released).toBe(true);
  });

  it("terminalizes a distinct accepted recovery when later cancellation throws", async () => {
    const operation = createReplyOperation({
      sessionKey: "agent:main:telegram:topic:dual-recovery-error",
      sessionId: "session-dual-recovery-error",
      resetTriggered: false,
    });
    operation.attachBackend({
      kind: "embedded",
      runId: "run-dual-recovery-error-successor",
      cancel: () => {},
    });
    const lease: MainSessionRecoveryOwnerLease = {
      cycleId: "cycle-dual-recovery-error-successor",
      lifecycleGeneration: "generation-dual-recovery-error",
      claimId: "claim-dual-recovery-error-successor",
      sessionId: operation.sessionId,
      sessionKey: operation.key,
      storePath: "/tmp/dual-recovery-error.sessions.json",
    };
    const recoveryRun = {
      lifecycleGeneration: "generation-dual-recovery-error",
      runId: "run-dual-recovery-error-older",
      sessionId: operation.sessionId,
      sessionKey: operation.key,
      storePath: lease.storePath,
    };
    setReplyRecoveryOwner(operation, lease);
    recoveryMocks.abortRun.mockResolvedValue({
      kind: "applied",
      entry: {
        sessionId: operation.sessionId,
        status: "killed",
        abortedLastRun: true,
        updatedAt: 10,
      },
      sessionKey: operation.key,
    });
    recoveryMocks.repair.mockImplementation(async (params) => await params.mutation());
    let recoveryRunAborted = false;

    await expect(
      runReplyRecoveryUserAbort({
        operation,
        recoveryRun,
        didAbortRecoveryRun: () => recoveryRunAborted,
        abort: () => {
          recoveryRunAborted = true;
          throw new Error("later cancellation failed");
        },
        logLabel: operation.key,
      }),
    ).rejects.toThrow("later cancellation failed");
    expect(recoveryMocks.abortOwner).not.toHaveBeenCalled();
    expect(recoveryMocks.abortRun).toHaveBeenCalledWith(recoveryRun);
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
      abortSessionRunTarget({
        key: operation.key,
        sessionId: operation.sessionId,
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
        didAbortRecoveryRun: () => true,
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
        didAbortRecoveryRun: () => false,
        abort: () => ({ active: true, aborted: false }),
        logLabel: recoveryRun.sessionKey,
      }),
    ).resolves.toEqual({ active: true, aborted: false });
    expect(recoveryMocks.abortRun).not.toHaveBeenCalled();
    expect(recoveryMocks.repair).not.toHaveBeenCalled();
  });

  it("terminalizes an accepted operationless recovery when later cancellation throws", async () => {
    const recoveryRun = {
      lifecycleGeneration: "generation-operationless-error",
      runId: "run-operationless-error",
      sessionId: "session-operationless-error",
      sessionKey: "agent:main:telegram:topic:operationless-error",
      storePath: "/tmp/operationless-error.sessions.json",
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
    let accepted = false;

    await expect(
      runReplyRecoveryUserAbort({
        operation: undefined,
        recoveryRun,
        didAbortRecoveryRun: () => accepted,
        abort: () => {
          accepted = true;
          throw new Error("later cancellation failed");
        },
        logLabel: recoveryRun.sessionKey,
      }),
    ).rejects.toThrow("later cancellation failed");
    expect(recoveryMocks.abortRun).toHaveBeenCalledWith(recoveryRun);
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
        didAbortRecoveryRun: () => true,
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
