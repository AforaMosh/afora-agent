import { afterEach, describe, expect, it, vi } from "vitest";
import type { MainSessionRecoveryOwnerLease } from "../../agents/main-session-recovery-store.js";
import type { InternalSessionEntry } from "../../config/sessions.js";
import { abortSessionRunTarget } from "./abort.js";
import {
  prepareReplyRecoveryUserAbort,
  setReplyRecoveryOwner,
  waitForReplyRecoveryAbortPersistence,
} from "./reply-recovery-owner.js";
import { createReplyOperation } from "./reply-run-registry.js";
import { testing as replyRunTesting } from "./reply-run-registry.test-support.js";

const recoveryMocks = vi.hoisted(() => ({
  abortOwner: vi.fn(),
  repair: vi.fn(),
}));

type PreparedRecoveryAbort = NonNullable<ReturnType<typeof prepareReplyRecoveryUserAbort>>;
type ReplyRecoveryAbortResult = Awaited<PreparedRecoveryAbort["result"]>;

vi.mock("../../agents/main-session-recovery-lifecycle.js", () => ({
  repairMainSessionRecoveryMutation: recoveryMocks.repair,
}));

vi.mock("../../agents/main-session-recovery-store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/main-session-recovery-store.js")>()),
  abortMainSessionRecoveryOwner: recoveryMocks.abortOwner,
}));

afterEach(() => {
  replyRunTesting.resetReplyRunRegistry();
  recoveryMocks.abortOwner.mockReset();
  recoveryMocks.repair.mockReset();
});

describe("reply recovery owner", () => {
  it("keeps owner release fenced until deferred abort persistence succeeds", async () => {
    let deferredSuccess:
      | ((result: Exclude<ReplyRecoveryAbortResult, { kind: "persistence_failed" }>) => void)
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

    const prepared = prepareReplyRecoveryUserAbort(operation);
    if (!prepared) {
      throw new Error("expected recovery abort preparation");
    }
    prepared.commit();

    await expect(prepared.result).resolves.toEqual({
      kind: "persistence_failed",
      error: "temporary writer outage",
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
});
