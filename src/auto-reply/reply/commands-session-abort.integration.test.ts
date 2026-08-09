import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  setActiveEmbeddedRun,
  type EmbeddedAgentQueueHandle,
} from "../../agents/embedded-agent-runner/runs.js";
import { testing as embeddedRunsTesting } from "../../agents/embedded-agent-runner/runs.test-support.js";
import {
  markStartupOrphanedMainSessionsForRecovery,
  recoverRestartAbortedMainSessions,
} from "../../agents/main-session-restart-recovery.js";
import {
  resetConfigRuntimeState,
  setRuntimeConfigSnapshot,
  type OpenClawConfig,
} from "../../config/config.js";
import type { InternalSessionEntry } from "../../config/sessions.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { GatewayRecoveryRuntime } from "../../gateway/server-instance-runtime.types.js";
import { persistGatewaySessionLifecycleEvent } from "../../gateway/session-lifecycle-state.js";
import { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { runExclusiveSessionLifecycleMutation } from "../../sessions/session-lifecycle-admission.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { tryFastAbortFromMessage } from "./abort.js";
import { testing as replyRunTesting } from "./reply-run-registry.test-support.js";
import { admitReplyTurn } from "./reply-turn-admission.js";
import { initSessionState } from "./session.js";
import { buildTestCtx } from "./test-ctx.js";

const recoveryOwnerReleaseMocks = vi.hoisted(() => ({
  schedulePendingTarget: vi.fn(),
}));

vi.mock("../../agents/main-session-recovery-owner-release.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/main-session-recovery-owner-release.js")>()),
  scheduleMainSessionRecoveryPendingTarget: recoveryOwnerReleaseMocks.schedulePendingTarget,
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  embeddedRunsTesting.resetActiveEmbeddedRuns();
  replyRunTesting.resetReplyRunRegistry();
  resetConfigRuntimeState();
  closeOpenClawAgentDatabasesForTest();
  recoveryOwnerReleaseMocks.schedulePendingTarget.mockClear();
});

describe("session abort command integration", () => {
  it("keeps a recovery-owned Codex App Server /stop terminal through delayed completion and restart", async () => {
    const sessionKey = "agent:main:telegram:topic:command-recovery-abort";
    const sessionId = "session-command-recovery-abort";
    const runId = "run-command-recovery-abort";
    const storePath = path.join(tempDirs.make("command-recovery-abort-"), "sessions.json");
    const cfg = { session: { store: storePath } } as OpenClawConfig;
    setRuntimeConfigSnapshot(cfg, cfg);
    const interruptedEntry: InternalSessionEntry = {
      agentHarnessId: "codex",
      sessionId,
      status: "running",
      abortedLastRun: true,
      updatedAt: 100,
      mainRestartRecovery: {
        cycleId: "cycle-command-recovery-abort",
        revision: 1,
        chargedAttempts: 0,
      },
    };
    await replaceSessionEntry({ storePath, sessionKey }, interruptedEntry);

    const admission = await admitReplyTurn({
      sessionKey,
      sessionId,
      expectedSessionId: sessionId,
      storePath,
      kind: "visible",
      resetTriggered: false,
    });
    if (admission.status !== "owned") {
      throw new Error("expected recovery-owned reply admission");
    }
    const appServerTurnCompleted = createDeferred();
    let appServerTurnCompletionObserved = false;
    const cancelBackend = vi.fn(() => {
      void appServerTurnCompleted.promise.then(() => {
        appServerTurnCompletionObserved = true;
      });
    });
    admission.operation.attachBackend({
      kind: "embedded",
      runId,
      cancel: cancelBackend,
      isAbortable: () => true,
      isStreaming: () => true,
    });
    admission.operation.setPhase("running");
    let embeddedAborted = false;
    const handle: EmbeddedAgentQueueHandle = {
      runId,
      abort: () => {
        embeddedAborted = true;
      },
      isCompacting: () => false,
      isStreaming: () => true,
      queueMessage: async () => {},
    };
    setActiveEmbeddedRun(sessionId, handle, sessionKey);
    await expect(
      tryFastAbortFromMessage({
        cfg,
        ctx: buildTestCtx({
          CommandAuthorized: true,
          CommandBody: "/stop",
          From: "telegram:owner",
          Provider: "telegram",
          RawBody: "/stop",
          SessionKey: sessionKey,
          Surface: "telegram",
          To: "telegram:bot",
        }),
      }),
    ).resolves.toMatchObject({
      handled: true,
      aborted: true,
    });
    expect(embeddedAborted).toBe(true);
    expect(cancelBackend).toHaveBeenCalledOnce();
    expect(admission.operation).toMatchObject({
      phase: "aborted",
      result: { kind: "aborted", code: "aborted_by_user" },
    });
    expect(appServerTurnCompletionObserved).toBe(false);

    const cancelledEntry = loadSessionEntry({ storePath, sessionKey });
    expect(cancelledEntry).toMatchObject({
      lifecycleRunId: runId,
      sessionId,
      status: "killed",
      abortedLastRun: true,
    });
    expect(
      (cancelledEntry as InternalSessionEntry | undefined)?.mainRestartRecovery,
    ).toBeUndefined();

    await persistGatewaySessionLifecycleEvent({
      agentId: "main",
      sessionKey,
      event: {
        ts: 200,
        sessionId,
        runId,
        data: { phase: "start", startedAt: 200 },
      },
    });
    expect(loadSessionEntry({ storePath, sessionKey })).toStrictEqual(cancelledEntry);
    expect(appServerTurnCompletionObserved).toBe(false);

    appServerTurnCompleted.resolve();
    await vi.waitFor(() => expect(appServerTurnCompletionObserved).toBe(true));
    admission.operation.complete();
    await runExclusiveSessionLifecycleMutation({
      scope: storePath,
      identities: [sessionKey],
      run: async () => {},
    });
    await vi.waitFor(() =>
      expect(recoveryOwnerReleaseMocks.schedulePendingTarget).toHaveBeenCalledWith(undefined),
    );
    expect(
      recoveryOwnerReleaseMocks.schedulePendingTarget.mock.calls.some(
        ([pendingTarget]) => pendingTarget !== undefined,
      ),
    ).toBe(false);

    const successor = await initSessionState({
      commandAuthorized: true,
      ctx: buildTestCtx({
        Body: "continue",
        RawBody: "continue",
        CommandBody: "continue",
        SessionKey: sessionKey,
        Provider: "telegram",
        Surface: "telegram",
        From: "telegram:command-abort-successor",
        To: "telegram:command-abort-successor",
      }),
      cfg,
    });
    expect(successor).toMatchObject({
      isNewSession: false,
      sessionId,
      sessionEntry: {
        sessionId,
        status: undefined,
      },
    });
    const successorAdmission = await admitReplyTurn({
      sessionKey,
      sessionId,
      expectedSessionId: sessionId,
      storePath,
      kind: "visible",
      resetTriggered: false,
    });
    if (successorAdmission.status !== "owned") {
      throw new Error("expected successor reply admission");
    }
    successorAdmission.operation.setPhase("running");
    await persistGatewaySessionLifecycleEvent({
      agentId: "main",
      sessionKey,
      event: {
        ts: 300,
        sessionId,
        runId: "run-command-abort-successor",
        data: { phase: "start", startedAt: 300 },
      },
    });
    expect(loadSessionEntry({ storePath, sessionKey })).toMatchObject({
      lifecycleRunId: "run-command-abort-successor",
      sessionId,
      status: "running",
    });
    await persistGatewaySessionLifecycleEvent({
      agentId: "main",
      sessionKey,
      event: {
        ts: 400,
        sessionId,
        runId: "run-command-abort-successor",
        data: { phase: "end", startedAt: 300, endedAt: 400 },
      },
    });
    successorAdmission.operation.complete();
    await runExclusiveSessionLifecycleMutation({
      scope: storePath,
      identities: [sessionKey],
      run: async () => {},
    });
    expect(loadSessionEntry({ storePath, sessionKey })).toMatchObject({
      sessionId,
      status: "done",
      abortedLastRun: false,
    });

    rotateAgentEventLifecycleGeneration();
    const dispatchAgent = vi.fn(async () => ({ runId: "unexpected-recovery" }));
    const waitForAgent = vi.fn(async () => ({ status: "finished" }));
    const sendRecoveryNotice = vi.fn(async () => {});
    const gatewayRuntime = {
      dispatchAgent: dispatchAgent as GatewayRecoveryRuntime["dispatchAgent"],
      waitForAgent: waitForAgent as GatewayRecoveryRuntime["waitForAgent"],
      sendRecoveryNotice,
    };
    await expect(
      markStartupOrphanedMainSessionsForRecovery({
        cfg,
        updatedBeforeMs: Date.now() + 1,
      }),
    ).resolves.toEqual({ marked: 0, skipped: 0 });
    await expect(
      recoverRestartAbortedMainSessions({
        cfg,
        gatewayRuntime,
      }),
    ).resolves.toEqual({ recovered: 0, failed: 0, skipped: 0 });
    expect(dispatchAgent).not.toHaveBeenCalled();
    expect(waitForAgent).not.toHaveBeenCalled();
    expect(sendRecoveryNotice).not.toHaveBeenCalled();
  });
});
