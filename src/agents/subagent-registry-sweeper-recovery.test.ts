import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayRecoveryRuntime } from "../gateway/server-instance-runtime.types.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { reconcileDurableSubagentKillIntent } from "./subagent-registry-sweep-kill.js";
import { retireSupersededSubagentRun } from "./subagent-registry-sweeper-retire.js";
import { createSubagentRegistrySweeper } from "./subagent-registry-sweeper.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { createSubagentRunRecord } from "./subagent-test-fixtures.test-helpers.js";

const recoverRow = vi.hoisted(() => vi.fn());
const getAgentRunContext = vi.hoisted(() => vi.fn<(_runId: string) => unknown>(() => undefined));
const removeInternalSessionEffectsSession = vi.hoisted(() => vi.fn(async () => {}));
const detachedTaskRuntime = vi.hoisted(() => ({
  finalizeTaskRunByRunId: vi.fn(() => [] as unknown[]),
  findDetachedTaskRun: vi.fn(() => undefined as unknown),
}));
const killRuntime = vi.hoisted(() => ({
  abortEmbeddedAgentRun: vi.fn(() => false),
  isEmbeddedAgentRunActive: vi.fn(() => false),
  clearSessionQueues: vi.fn(() => ({ followupCleared: 0, laneCleared: 0, keys: [] })),
}));
const killSessionEntry = vi.hoisted(() => ({
  current: undefined as
    | { sessionId: string; lifecycleRevision?: string; updatedAt: number }
    | undefined,
}));
vi.mock("./subagent-registry-restart-recovery.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./subagent-registry-restart-recovery.js")>();
  return {
    ...actual,
    recoverInterruptedSubagentRow: recoverRow,
  };
});
vi.mock("../infra/agent-events.js", () => ({
  isAgentEventLifecycleGenerationCurrent: () => true,
}));
vi.mock("../infra/agent-run-registry.js", () => ({
  getAgentRunContext,
}));
vi.mock("./internal-session-effects.js", () => ({
  removeInternalSessionEffectsSession,
}));
vi.mock("../tasks/detached-task-runtime.js", () => detachedTaskRuntime);
vi.mock("./subagent-control.runtime.js", () => killRuntime);
vi.mock("./subagent-session-reconciliation.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./subagent-session-reconciliation.js")>();
  return {
    ...actual,
    loadSubagentSessionEntry: vi.fn(() => killSessionEntry.current),
  };
});

function run(): SubagentRunRecord {
  return createSubagentRunRecord({
    runId: "interrupted-run",
    childSessionKey: "agent:main:subagent:interrupted",
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "recover after restart",
    cleanup: "keep",
    createdAt: Date.now() - 60_000,
    startedAt: Date.now() - 55_000,
  });
}

function createHarness(runtime: { current?: GatewayRecoveryRuntime }) {
  const entry = run();
  const runs = new Map([[entry.runId, entry]]);
  const resumedRuns = new Set<string>();
  const finalizeInterruptedSubagentRun = vi.fn(
    async (_params: {
      runId: string;
      expectedEntry?: SubagentRunRecord;
      error: string;
      endedAt?: number;
    }) => 0,
  );
  const completeSubagentRunWithRecovery = vi.fn();
  const completeCleanupBookkeeping = vi.fn();
  const emitSubagentEndedHookForRun = vi.fn();
  const notifyContextEngineSubagentEnded = vi.fn();
  const callGateway = vi.fn();
  const resumeRequesterSettleWake = vi.fn();
  const startSubagentAnnounceCleanupFlow = vi.fn(() => true);
  const warn = vi.fn();
  const sweeper = createSubagentRegistrySweeper({
    runs,
    resumedRuns,
    persist: vi.fn(),
    clearPendingLifecycleError: vi.fn(),
    clearPendingLifecycleTimeout: vi.fn(),
    sweepPendingLifecycle: vi.fn(),
    completeSubagentRunWithRecovery,
    getGatewayRecoveryRuntime: () => runtime.current,
    abandonSubagentRestartRecoveryLaunch: vi.fn(() => true),
    clearAcceptedSubagentRestartRecovery: vi.fn(() => true),
    resumeSettledSubagentRestartRecovery: vi.fn(() => true),
    replaceSubagentRunAfterSteer: vi.fn(() => true),
    markSubagentRestartRecoveryLaunchAttempted: vi.fn((params) => ({
      sessionId: "session-id",
      sessionMarker: params.sessionMarker,
      idempotencyKey: params.idempotencyKey,
      lifecycleGeneration: params.lifecycleGeneration,
      phase: "attempted" as const,
    })),
    markSubagentRestartRecoveryLaunchAccepted: vi.fn((params) => ({
      sessionId: "session-id",
      sessionMarker: params.sessionMarker,
      idempotencyKey: params.idempotencyKey,
      phase: "accepted" as const,
    })),
    markSubagentRestartRecoveryLaunchConsumed: vi.fn((params) => ({
      sessionId: "session-id",
      sessionMarker: params.sessionMarker,
      idempotencyKey: params.idempotencyKey,
      phase: "consumed" as const,
    })),
    reserveSubagentRestartRecoveryLaunch: vi.fn(
      (params: { idempotencyKey: string }) => params.idempotencyKey,
    ),
    resetSubagentRestartRecoveryLaunchAttempt: vi.fn(() => true),
    finalizeInterruptedSubagentRun,
    resumeRequesterSettleWake,
    startSubagentAnnounceCleanupFlow,
    completeCleanupBookkeeping,
    shouldEmitEndedHookForRun: vi.fn(() => false),
    emitSubagentEndedHookForRun,
    callGateway,
    cleanupCollectorLaunchResources: vi.fn(async () => true),
    runContextEngineSubagentEnded: vi.fn(),
    notifyContextEngineSubagentEnded,
    retireSupersededRun: vi.fn(),
    getRunsForChildSession: () => [],
    getRunsForCollectorGroup: () => [],
    warn,
  });
  return {
    entry,
    runs,
    callGateway,
    completeCleanupBookkeeping,
    completeSubagentRunWithRecovery,
    emitSubagentEndedHookForRun,
    finalizeInterruptedSubagentRun,
    notifyContextEngineSubagentEnded,
    resumedRuns,
    resumeRequesterSettleWake,
    startSubagentAnnounceCleanupFlow,
    sweeper,
    warn,
  };
}

describe("subagent registry recovery scheduling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetGatewayWorkAdmission();
    recoverRow.mockReset();
    getAgentRunContext.mockReset().mockReturnValue(undefined);
    killRuntime.abortEmbeddedAgentRun.mockReset().mockReturnValue(false);
    killRuntime.isEmbeddedAgentRunActive.mockReset().mockReturnValue(false);
    killRuntime.clearSessionQueues.mockReset().mockReturnValue({
      followupCleared: 0,
      laneCleared: 0,
      keys: [],
    });
    killSessionEntry.current = {
      sessionId: "session-id",
      lifecycleRevision: "session-revision",
      updatedAt: Date.now(),
    };
    detachedTaskRuntime.finalizeTaskRunByRunId.mockReset().mockReturnValue([]);
    detachedTaskRuntime.findDetachedTaskRun.mockReset().mockReturnValue(undefined);
    removeInternalSessionEffectsSession.mockReset();
  });

  afterEach(() => {
    resetGatewayWorkAdmission();
    vi.useRealTimers();
  });

  it("recovers an active yielded child before admitting its frozen requester wake", async () => {
    const runtime = { current: {} as GatewayRecoveryRuntime };
    recoverRow.mockResolvedValue({ status: "handled" });
    const { entry, resumeRequesterSettleWake, sweeper } = createHarness(runtime);
    entry.requesterSettleWake = {
      status: "pending",
      attemptCount: 0,
      batchRunIds: [entry.runId],
      requesterYieldBatch: true,
      rearmGeneration: 1,
    };

    await sweeper.sweepOnce();

    expect(resumeRequesterSettleWake).not.toHaveBeenCalled();
    expect(recoverRow).toHaveBeenCalledOnce();
    expect(entry.requesterSettleWake?.rearmGeneration).toBe(1);
    sweeper.reset();
  });

  it("leaves an interrupted yielded terminal to its recovery owner before admitting its wake", async () => {
    const runtime = { current: {} as GatewayRecoveryRuntime };
    recoverRow.mockResolvedValue({ status: "handled" });
    const { entry, resumeRequesterSettleWake, sweeper } = createHarness(runtime);
    entry.execution = { ...entry.execution, status: "terminal", endedAt: Date.now() };
    entry.terminalOwner = "interrupted-recovery";
    entry.delivery = { status: "pending" };
    entry.requesterSettleWake = {
      status: "pending",
      attemptCount: 0,
      batchRunIds: [entry.runId],
      requesterYieldBatch: true,
      rearmGeneration: 1,
    };

    await sweeper.sweepOnce();

    expect(resumeRequesterSettleWake).not.toHaveBeenCalled();
    expect(recoverRow).toHaveBeenCalledOnce();
    sweeper.reset();
  });

  it.each([
    { name: "pending delivery", delivery: { status: "pending" as const } },
    { name: "in-progress delivery", delivery: { status: "in_progress" as const } },
    {
      name: "retryable failed delivery",
      delivery: { status: "failed" as const, disposition: "retryable" as const },
    },
    {
      name: "delivered visible final awaiting cleanup",
      delivery: { status: "delivered" as const, requesterVisibleFinalGeneration: 1 },
    },
    {
      name: "delivered visible final with a stale retry deadline",
      delivery: {
        status: "delivered" as const,
        requesterVisibleFinalGeneration: 1,
        nextAttemptAt: Number.MAX_SAFE_INTEGER,
      },
    },
    {
      name: "already announced completion with a stale retry deadline",
      delivery: {
        status: "pending" as const,
        announcedAt: 4_000,
        nextAttemptAt: Number.MAX_SAFE_INTEGER,
      },
    },
    {
      name: "failed child with a succeeded redelivery task",
      delivery: { status: "pending" as const },
      outcome: { status: "error", error: "child failed" } as const,
    },
    {
      name: "failed child with its original failed task",
      delivery: { status: "pending" as const },
      outcome: { status: "error", error: "child failed" } as const,
      taskStatus: "failed" as const,
    },
    {
      name: "timed-out child with a succeeded redelivery task",
      delivery: { status: "pending" as const },
      outcome: { status: "timeout" } as const,
    },
    {
      name: "timed-out child with its original timed-out task",
      delivery: { status: "pending" as const },
      outcome: { status: "timeout" } as const,
      taskStatus: "timed_out" as const,
    },
    {
      name: "cancelled child after its kill owner has retired",
      delivery: { status: "pending" as const },
      outcome: { status: "error", error: "Subagent run killed." } as const,
      endedReason: "subagent-killed" as const,
      taskStatus: "cancelled" as const,
    },
    {
      name: "captured empty completion",
      delivery: { status: "pending" as const },
      resultText: null,
    },
  ])(
    "resumes the canonical cleanup owner for a restored yielded $name",
    async ({ delivery, endedReason, outcome, resultText, taskStatus }) => {
      const {
        entry,
        resumedRuns,
        resumeRequesterSettleWake,
        startSubagentAnnounceCleanupFlow,
        sweeper,
      } = createHarness({});
      entry.execution = {
        ...entry.execution,
        status: "terminal",
        endedAt: Date.now(),
        outcome: outcome ?? { status: "ok" },
      };
      entry.endedReason =
        endedReason ?? (outcome?.status === "error" ? "subagent-error" : "subagent-complete");
      if (endedReason === "subagent-killed") {
        entry.suppressCompletionDelivery = true;
      }
      entry.completion = {
        required: true,
        resultText: resultText === null ? null : "child result",
      };
      entry.delivery = delivery;
      entry.requesterSettleWake = {
        status: "pending",
        attemptCount: 0,
        batchRunIds: [entry.runId],
        requesterYieldBatch: true,
        rearmGeneration: 1,
      };
      detachedTaskRuntime.findDetachedTaskRun.mockReturnValue({
        lookup: "available",
        task: {
          runId: entry.runId,
          runtime: "subagent",
          childSessionKey: entry.childSessionKey,
          status: taskStatus ?? "succeeded",
          createdAt: entry.createdAt,
          endedAt: entry.execution.endedAt,
        },
      });

      await sweeper.sweepOnce();

      expect(startSubagentAnnounceCleanupFlow).toHaveBeenCalledOnce();
      expect(startSubagentAnnounceCleanupFlow).toHaveBeenCalledWith(entry.runId, entry);
      expect(resumedRuns.has(entry.runId)).toBe(true);
      expect(resumeRequesterSettleWake).not.toHaveBeenCalled();
      sweeper.reset();
    },
  );

  it.each([
    {
      name: "its cancellation belongs to the paused child",
      prepare: () => {},
      recovers: true,
    },
    {
      name: "a stale delivery retry deadline survived cancellation",
      prepare: (entry: SubagentRunRecord) => {
        entry.delivery = { status: "pending", nextAttemptAt: Number.MAX_SAFE_INTEGER };
      },
      recovers: true,
    },
    {
      name: "completion delivery was not authoritatively suppressed",
      prepare: (entry: SubagentRunRecord) => {
        entry.suppressCompletionDelivery = undefined;
      },
      recovers: false,
    },
    {
      name: "the terminal owner was not a kill",
      prepare: (entry: SubagentRunRecord) => {
        entry.endedReason = "subagent-error";
      },
      recovers: false,
    },
    {
      name: "the child outcome was not an error",
      prepare: (entry: SubagentRunRecord) => {
        entry.execution = { ...entry.execution, outcome: { status: "ok" } };
      },
      recovers: false,
    },
    {
      name: "the cancelled task predates the paused child",
      prepare: (
        entry: SubagentRunRecord,
        task: { status: "cancelled" | "succeeded"; endedAt: number },
      ) => {
        task.endedAt = entry.execution.endedAt! - 1;
      },
      recovers: false,
    },
    {
      name: "the task belongs to a foreign generation",
      prepare: () => {
        detachedTaskRuntime.findDetachedTaskRun.mockReturnValue({ lookup: "available" });
      },
      recovers: false,
    },
    {
      name: "the exact-generation task was not cancelled",
      prepare: (
        _entry: SubagentRunRecord,
        task: { status: "cancelled" | "succeeded"; endedAt: number },
      ) => {
        task.status = "succeeded";
      },
      recovers: false,
    },
  ])("recovers a killed paused requester child only when $name", async ({ prepare, recovers }) => {
    const {
      entry,
      resumedRuns,
      resumeRequesterSettleWake,
      startSubagentAnnounceCleanupFlow,
      sweeper,
    } = createHarness({});
    const pausedAt = Date.now() - 1_000;
    entry.execution = {
      ...entry.execution,
      status: "terminal",
      endedAt: pausedAt,
      outcome: { status: "error", error: "Subagent run killed." },
    };
    entry.endedReason = "subagent-killed";
    entry.suppressCompletionDelivery = true;
    entry.completion = { required: true };
    entry.delivery = { status: "pending" };
    entry.requesterSettleWake = {
      status: "pending",
      attemptCount: 0,
      batchRunIds: [entry.runId],
      requesterYieldBatch: true,
      rearmGeneration: 1,
    };
    const task: {
      runId: string;
      runtime: "subagent";
      childSessionKey: string;
      status: "cancelled" | "succeeded";
      createdAt: number;
      endedAt: number;
    } = {
      runId: entry.runId,
      runtime: "subagent",
      childSessionKey: entry.childSessionKey,
      status: "cancelled",
      createdAt: entry.createdAt,
      endedAt: pausedAt + 1_000,
    };
    detachedTaskRuntime.findDetachedTaskRun.mockReturnValue({ lookup: "available", task });
    prepare(entry, task);

    await sweeper.sweepOnce();

    expect(startSubagentAnnounceCleanupFlow).toHaveBeenCalledTimes(recovers ? 1 : 0);
    expect(resumedRuns.has(entry.runId)).toBe(recovers);
    expect(resumeRequesterSettleWake).not.toHaveBeenCalled();
    sweeper.reset();
  });

  it.each([
    {
      name: "completion capture has not finished",
      prepare: (entry: SubagentRunRecord) => {
        entry.completion = { required: true };
      },
    },
    {
      name: "the cleanup owner is active",
      prepare: (entry: SubagentRunRecord) => {
        entry.cleanupHandled = true;
      },
    },
    {
      name: "the execution context is active",
      prepare: () => {
        getAgentRunContext.mockReturnValue({});
      },
    },
    {
      name: "the retry deadline has not arrived",
      prepare: (entry: SubagentRunRecord) => {
        entry.delivery = { status: "pending", nextAttemptAt: Date.now() + 10_000 };
      },
    },
    {
      name: "the correlated delivery queue owns settlement",
      prepare: (entry: SubagentRunRecord) => {
        entry.delivery = { status: "in_progress", disposition: "session_queued" };
      },
    },
    {
      name: "a staged terminal reply has not finalized its task",
      prepare: (entry: SubagentRunRecord) => {
        entry.completion = {
          required: true,
          resultText: "premature terminal reply",
          terminalReply: { disposition: "visible", text: "premature terminal reply" },
        };
        detachedTaskRuntime.findDetachedTaskRun.mockReturnValue({
          lookup: "available",
          task: { runId: entry.runId, status: "running" },
        });
      },
    },
    {
      name: "the exact-generation task is unavailable",
      prepare: () => {
        detachedTaskRuntime.findDetachedTaskRun.mockReturnValue({ lookup: "unavailable" });
      },
    },
    {
      name: "the exact-generation task is missing",
      prepare: () => {
        detachedTaskRuntime.findDetachedTaskRun.mockReturnValue({ lookup: "available" });
      },
    },
    {
      name: "the exact-generation task was only marked lost",
      prepare: (entry: SubagentRunRecord) => {
        detachedTaskRuntime.findDetachedTaskRun.mockReturnValue({
          lookup: "available",
          task: { runId: entry.runId, status: "lost" },
        });
      },
    },
    {
      name: "the exact-generation task was cancelled",
      prepare: (entry: SubagentRunRecord) => {
        detachedTaskRuntime.findDetachedTaskRun.mockReturnValue({
          lookup: "available",
          task: { runId: entry.runId, status: "cancelled", endedAt: entry.execution.endedAt },
        });
      },
    },
    {
      name: "a cancelled completion points at an unrelated successful task",
      prepare: (entry: SubagentRunRecord) => {
        entry.execution = {
          ...entry.execution,
          outcome: { status: "error", error: "Subagent run killed." },
        };
        entry.endedReason = "subagent-killed";
        entry.suppressCompletionDelivery = true;
      },
    },
    {
      name: "the exact-generation task contradicts a successful completion",
      prepare: (entry: SubagentRunRecord) => {
        detachedTaskRuntime.findDetachedTaskRun.mockReturnValue({
          lookup: "available",
          task: { runId: entry.runId, status: "failed", endedAt: entry.execution.endedAt },
        });
      },
    },
    {
      name: "the exact-generation task ended at a different instant",
      prepare: (entry: SubagentRunRecord) => {
        detachedTaskRuntime.findDetachedTaskRun.mockReturnValue({
          lookup: "available",
          task: { runId: entry.runId, status: "succeeded", endedAt: entry.execution.endedAt! + 1 },
        });
      },
    },
    {
      name: "the terminal-looking child is paused after yielding",
      prepare: (entry: SubagentRunRecord) => {
        entry.pauseReason = "sessions_yield";
      },
    },
    {
      name: "the terminal-looking child has no completion outcome",
      prepare: (entry: SubagentRunRecord) => {
        entry.execution = { ...entry.execution, outcome: undefined };
      },
    },
    {
      name: "the terminal completion has no authoritative ended reason",
      prepare: (entry: SubagentRunRecord) => {
        entry.endedReason = undefined;
      },
    },
  ])("does not compete with a yielded completion when $name", async ({ prepare }) => {
    const { entry, resumeRequesterSettleWake, startSubagentAnnounceCleanupFlow, sweeper } =
      createHarness({});
    entry.execution = {
      ...entry.execution,
      status: "terminal",
      endedAt: Date.now(),
      outcome: { status: "ok" },
    };
    entry.endedReason = "subagent-complete";
    entry.completion = { required: true, resultText: "child result" };
    entry.delivery = { status: "pending" };
    entry.requesterSettleWake = {
      status: "pending",
      attemptCount: 0,
      batchRunIds: [entry.runId],
      requesterYieldBatch: true,
      rearmGeneration: 1,
    };
    detachedTaskRuntime.findDetachedTaskRun.mockReturnValue({
      lookup: "available",
      task: {
        runId: entry.runId,
        runtime: "subagent",
        childSessionKey: entry.childSessionKey,
        status: "succeeded",
        createdAt: entry.createdAt,
        endedAt: entry.execution.endedAt,
      },
    });
    prepare(entry);

    await sweeper.sweepOnce();

    expect(startSubagentAnnounceCleanupFlow).not.toHaveBeenCalled();
    expect(resumeRequesterSettleWake).not.toHaveBeenCalled();
    sweeper.reset();
  });

  it.each([
    { name: "suspended salvage", delivery: { status: "suspended" as const, suspendedAt: 4_000 } },
    {
      name: "terminal failed salvage",
      delivery: { status: "failed" as const, disposition: "permanent_failure" as const },
      cleanupCompletedAt: 5_000,
    },
    {
      name: "a delivered completion without a final marker",
      delivery: { status: "delivered" as const },
    },
    {
      name: "a delivered completion from an older final generation",
      delivery: { status: "delivered" as const, requesterVisibleFinalGeneration: 0 },
    },
    {
      name: "a delivered final whose cleanup already completed",
      delivery: { status: "delivered" as const, requesterVisibleFinalGeneration: 1 },
      cleanupCompletedAt: 5_000,
    },
  ])(
    "preserves the legitimate requester wake for $name",
    async ({ delivery, cleanupCompletedAt }) => {
      const { entry, resumeRequesterSettleWake, startSubagentAnnounceCleanupFlow, sweeper } =
        createHarness({});
      entry.execution = {
        ...entry.execution,
        status: "terminal",
        endedAt: Date.now(),
        outcome: { status: "ok" },
      };
      entry.endedReason = "subagent-complete";
      entry.completion = { required: true, resultText: "child result" };
      entry.delivery = delivery;
      entry.cleanupCompletedAt = cleanupCompletedAt;
      entry.requesterSettleWake = {
        status: "pending",
        attemptCount: 0,
        batchRunIds: [entry.runId],
        requesterYieldBatch: true,
        rearmGeneration: 1,
      };

      await sweeper.sweepOnce();

      expect(resumeRequesterSettleWake).toHaveBeenCalledOnce();
      expect(startSubagentAnnounceCleanupFlow).not.toHaveBeenCalled();
      sweeper.reset();
    },
  );

  it("makes four dispatch attempts and three separate terminal attempts", async () => {
    const runtime = { current: {} as GatewayRecoveryRuntime };
    recoverRow.mockResolvedValue({ status: "retry", error: "gateway unavailable" });
    const { entry, finalizeInterruptedSubagentRun, sweeper, warn } = createHarness(runtime);

    await sweeper.sweepOnce();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(recoverRow).toHaveBeenCalledTimes(4);
    expect(finalizeInterruptedSubagentRun).toHaveBeenCalledTimes(3);
    expect(
      finalizeInterruptedSubagentRun.mock.calls.every(([params]) => params.expectedEntry === entry),
    ).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      "subagent interrupted terminal projection remains incomplete",
      { runId: "interrupted-run" },
    );
    recoverRow.mockResolvedValue({ status: "handled" });
    await sweeper.runTick();
    expect(recoverRow).toHaveBeenCalledTimes(5);
    sweeper.reset();
  });

  it("coalesces duplicate schedules before the owner pass starts", async () => {
    const runtime = { current: {} as GatewayRecoveryRuntime };
    recoverRow.mockResolvedValue({ status: "handled" });
    const { sweeper } = createHarness(runtime);

    sweeper.schedule({ delayMs: 1 });
    sweeper.schedule({ delayMs: 1 });
    await vi.advanceTimersByTimeAsync(1);

    expect(recoverRow).toHaveBeenCalledOnce();
    sweeper.reset();
  });

  it("re-resolves a missing runtime without consuming the dispatch budget", async () => {
    const runtime: { current?: GatewayRecoveryRuntime } = {};
    recoverRow.mockImplementation(async ({ gatewayRuntime }) =>
      gatewayRuntime ? { status: "handled" } : { status: "deferred" },
    );
    const { finalizeInterruptedSubagentRun, sweeper } = createHarness(runtime);

    await sweeper.sweepOnce();
    await vi.advanceTimersByTimeAsync(1_000);
    runtime.current = {} as GatewayRecoveryRuntime;
    await vi.advanceTimersByTimeAsync(1_000);

    expect(recoverRow).toHaveBeenCalledTimes(3);
    expect(finalizeInterruptedSubagentRun).not.toHaveBeenCalled();
    sweeper.reset();
  });

  it("never terminalizes deferred accepted-run reconciliation", async () => {
    const runtime = { current: {} as GatewayRecoveryRuntime };
    recoverRow.mockResolvedValue({ status: "deferred" });
    const { finalizeInterruptedSubagentRun, sweeper } = createHarness(runtime);

    await sweeper.sweepOnce();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(recoverRow.mock.calls.length).toBeGreaterThan(4);
    expect(finalizeInterruptedSubagentRun).not.toHaveBeenCalled();
    sweeper.reset();
  });

  it("does not terminalize a durable kill intent while runtime abort is rejected", async () => {
    const runtime = { current: {} as GatewayRecoveryRuntime };
    const { entry, completeSubagentRunWithRecovery, sweeper } = createHarness(runtime);
    entry.killIntent = {
      requestedAt: Date.now(),
      reason: "killed",
      sessionId: "session-id",
      lifecycleGeneration: "test-generation",
      sessionLifecycleRevision: "session-revision",
    };
    getAgentRunContext.mockReturnValue({});
    killRuntime.isEmbeddedAgentRunActive.mockReturnValue(true);

    await sweeper.sweepOnce();

    expect(killRuntime.abortEmbeddedAgentRun).toHaveBeenCalledWith("session-id");
    expect(killRuntime.clearSessionQueues).toHaveBeenCalledWith([
      entry.childSessionKey,
      "session-id",
    ]);
    expect(completeSubagentRunWithRecovery).not.toHaveBeenCalled();

    getAgentRunContext.mockReturnValue(undefined);
    killRuntime.isEmbeddedAgentRunActive.mockReturnValue(false);
    await sweeper.sweepOnce();

    expect(completeSubagentRunWithRecovery).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: entry.runId,
        expectedEntry: entry,
        reason: "subagent-killed",
      }),
      "sweeper-pending-kill-intent",
    );
    sweeper.reset();
  });

  it("terminalizes a legacy unowned kill without touching the current child session", async () => {
    const runtime = { current: {} as GatewayRecoveryRuntime };
    const { entry, completeSubagentRunWithRecovery, sweeper } = createHarness(runtime);
    entry.killIntent = {
      requestedAt: Date.now(),
      reason: "legacy killed",
      sessionId: "session-id",
    };

    await sweeper.sweepOnce();

    expect(killRuntime.isEmbeddedAgentRunActive).not.toHaveBeenCalled();
    expect(killRuntime.abortEmbeddedAgentRun).not.toHaveBeenCalled();
    expect(killRuntime.clearSessionQueues).not.toHaveBeenCalled();
    expect(completeSubagentRunWithRecovery).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: entry.runId,
        expectedEntry: entry,
        suppressSessionEffects: true,
      }),
      "sweeper-retired-kill-intent",
    );
    sweeper.reset();
  });

  it("does not apply a durable kill after runtime loading yields to a replacement row", async () => {
    const entry = run();
    entry.killIntent = {
      requestedAt: Date.now(),
      reason: "killed",
      sessionId: "session-id",
      lifecycleGeneration: "test-generation",
      sessionLifecycleRevision: "session-revision",
    };
    const runs = new Map([[entry.runId, entry]]);
    const replacement = run();
    let releaseRuntime!: () => void;
    const loadKillRuntime = vi.fn(
      () =>
        new Promise<typeof import("./subagent-control.runtime.js")>((resolve) => {
          releaseRuntime = () =>
            resolve(killRuntime as unknown as typeof import("./subagent-control.runtime.js"));
        }),
    );
    const completeSubagentRunWithRecovery = vi.fn();

    const pending = reconcileDurableSubagentKillIntent({
      runId: entry.runId,
      entry,
      runs,
      loadKillRuntime,
      completeSubagentRunWithRecovery,
      retireSupersededRun: vi.fn(),
      warn: vi.fn(),
    });
    await vi.waitFor(() => expect(loadKillRuntime).toHaveBeenCalledOnce());
    runs.set(entry.runId, replacement);
    releaseRuntime();

    await expect(pending).resolves.toBe(false);
    expect(killRuntime.isEmbeddedAgentRunActive).not.toHaveBeenCalled();
    expect(killRuntime.abortEmbeddedAgentRun).not.toHaveBeenCalled();
    expect(killRuntime.clearSessionQueues).not.toHaveBeenCalled();
    expect(completeSubagentRunWithRecovery).not.toHaveBeenCalled();
  });

  it("does not apply a durable kill after the same session id resets to a new revision", async () => {
    const entry = run();
    entry.killIntent = {
      requestedAt: Date.now(),
      reason: "killed",
      sessionId: "session-id",
      lifecycleGeneration: "test-generation",
      sessionLifecycleRevision: "session-revision",
    };
    const runs = new Map([[entry.runId, entry]]);
    let releaseRuntime!: () => void;
    const loadKillRuntime = vi.fn(
      () =>
        new Promise<typeof import("./subagent-control.runtime.js")>((resolve) => {
          releaseRuntime = () =>
            resolve(killRuntime as unknown as typeof import("./subagent-control.runtime.js"));
        }),
    );
    const completeSubagentRunWithRecovery = vi.fn();

    const pending = reconcileDurableSubagentKillIntent({
      runId: entry.runId,
      entry,
      runs,
      loadKillRuntime,
      completeSubagentRunWithRecovery,
      retireSupersededRun: vi.fn(),
      warn: vi.fn(),
    });
    await vi.waitFor(() => expect(loadKillRuntime).toHaveBeenCalledOnce());
    killSessionEntry.current = {
      sessionId: "session-id",
      lifecycleRevision: "replacement-revision",
      updatedAt: Date.now(),
    };
    releaseRuntime();

    await expect(pending).resolves.toBe(true);
    expect(killRuntime.isEmbeddedAgentRunActive).not.toHaveBeenCalled();
    expect(killRuntime.abortEmbeddedAgentRun).not.toHaveBeenCalled();
    expect(killRuntime.clearSessionQueues).not.toHaveBeenCalled();
    expect(completeSubagentRunWithRecovery).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: entry.runId,
        expectedEntry: entry,
        suppressSessionEffects: true,
      }),
      "sweeper-retired-kill-intent",
    );
  });

  it("does not apply an older durable kill when a newer child generation exists", async () => {
    const entry = run();
    entry.generation = 1;
    entry.killIntent = {
      requestedAt: Date.now(),
      reason: "killed",
      sessionId: "session-id",
    };
    const newer = createSubagentRunRecord({
      runId: "newer-run",
      childSessionKey: entry.childSessionKey,
      requesterSessionKey: entry.requesterSessionKey,
      requesterDisplayKey: entry.requesterDisplayKey,
      task: "newer generation",
      cleanup: "keep",
      generation: 2,
      createdAt: entry.createdAt + 1,
      startedAt: entry.execution.startedAt ? entry.execution.startedAt + 1 : Date.now(),
    });
    const runs = new Map([
      [entry.runId, entry],
      [newer.runId, newer],
    ]);
    const completeSubagentRunWithRecovery = vi.fn();
    const retireSupersededRun = vi.fn(async () => {});
    detachedTaskRuntime.findDetachedTaskRun.mockReturnValue({
      lookup: "available",
      task: {
        runId: entry.runId,
        runtime: "subagent",
        childSessionKey: entry.childSessionKey,
        status: "running",
        createdAt: entry.createdAt,
      },
    });
    detachedTaskRuntime.finalizeTaskRunByRunId.mockReturnValue([
      {
        runId: entry.runId,
        runtime: "subagent",
        childSessionKey: entry.childSessionKey,
        status: "cancelled",
        createdAt: entry.createdAt,
        endedAt: entry.killIntent.requestedAt,
      },
    ]);

    await expect(
      reconcileDurableSubagentKillIntent({
        runId: entry.runId,
        entry,
        runs,
        loadKillRuntime: async () =>
          killRuntime as unknown as typeof import("./subagent-control.runtime.js"),
        completeSubagentRunWithRecovery,
        retireSupersededRun,
        warn: vi.fn(),
      }),
    ).resolves.toBe(true);

    expect(killRuntime.isEmbeddedAgentRunActive).not.toHaveBeenCalled();
    expect(killRuntime.abortEmbeddedAgentRun).not.toHaveBeenCalled();
    expect(killRuntime.clearSessionQueues).not.toHaveBeenCalled();
    expect(completeSubagentRunWithRecovery).not.toHaveBeenCalled();
    expect(detachedTaskRuntime.finalizeTaskRunByRunId).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: entry.runId,
        status: "cancelled",
        suppressDelivery: true,
      }),
    );
    expect(retireSupersededRun).toHaveBeenCalledWith(entry.runId, entry);
  });

  it("retires a superseded kill when its detached task runtime is opaque", async () => {
    const entry = run();
    entry.generation = 1;
    entry.killIntent = {
      requestedAt: Date.now(),
      reason: "killed",
      sessionId: "session-id",
    };
    const newer = createSubagentRunRecord({
      runId: "newer-opaque-run",
      childSessionKey: entry.childSessionKey,
      requesterSessionKey: entry.requesterSessionKey,
      requesterDisplayKey: entry.requesterDisplayKey,
      task: "newer generation",
      cleanup: "keep",
      generation: 2,
      createdAt: entry.createdAt + 1,
      startedAt: entry.execution.startedAt ? entry.execution.startedAt + 1 : Date.now(),
    });
    const runs = new Map([
      [entry.runId, entry],
      [newer.runId, newer],
    ]);
    const retireSupersededRun = vi.fn(async () => {});
    detachedTaskRuntime.findDetachedTaskRun.mockReturnValue({ lookup: "unavailable" });

    await expect(
      reconcileDurableSubagentKillIntent({
        runId: entry.runId,
        entry,
        runs,
        loadKillRuntime: async () =>
          killRuntime as unknown as typeof import("./subagent-control.runtime.js"),
        completeSubagentRunWithRecovery: vi.fn(),
        retireSupersededRun,
        warn: vi.fn(),
      }),
    ).resolves.toBe(true);

    expect(detachedTaskRuntime.finalizeTaskRunByRunId).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: entry.runId,
        status: "cancelled",
        suppressDelivery: true,
      }),
    );
    expect(retireSupersededRun).toHaveBeenCalledWith(entry.runId, entry);
  });

  it("discards suspended retired recovery delivery without touching its child session", async () => {
    const runtime = { current: {} as GatewayRecoveryRuntime };
    const { entry, completeCleanupBookkeeping, emitSubagentEndedHookForRun, sweeper } =
      createHarness(runtime);
    entry.execution = {
      status: "terminal",
      startedAt: Date.now() - 60_000,
      endedAt: Date.now() - 55_000,
      outcome: { status: "error", error: "retired Gateway lifecycle" },
      suppressSessionEffects: true,
    };
    entry.endedReason = "subagent-error";
    entry.expectsCompletionMessage = true;
    entry.delivery = {
      status: "suspended",
      suspendedAt: Date.now() - 8 * 24 * 60 * 60_000,
      suspendedReason: "expiry",
      payload: {
        requesterSessionKey: entry.requesterSessionKey,
        requesterDisplayKey: entry.requesterDisplayKey,
        childSessionKey: entry.childSessionKey,
        childRunId: entry.runId,
        task: entry.task,
      },
    };

    await sweeper.sweepOnce();

    expect(removeInternalSessionEffectsSession).not.toHaveBeenCalled();
    expect(emitSubagentEndedHookForRun).not.toHaveBeenCalled();
    expect(completeCleanupBookkeeping).toHaveBeenCalledWith(
      expect.objectContaining({ runId: entry.runId, entry }),
    );
  });

  it("archives a retired recovery row without deleting its newer child session", async () => {
    const runtime = { current: {} as GatewayRecoveryRuntime };
    const { entry, runs, callGateway, notifyContextEngineSubagentEnded, sweeper } =
      createHarness(runtime);
    entry.cleanup = "delete";
    entry.archiveAtMs = Date.now() - 1;
    entry.execution = {
      status: "terminal",
      startedAt: Date.now() - 60_000,
      endedAt: Date.now() - 55_000,
      outcome: { status: "error", error: "retired Gateway lifecycle" },
      suppressSessionEffects: true,
    };
    entry.endedReason = "subagent-error";

    await sweeper.sweepOnce();

    expect(callGateway).not.toHaveBeenCalled();
    expect(notifyContextEngineSubagentEnded).not.toHaveBeenCalled();
    expect(runs.has(entry.runId)).toBe(false);
  });

  it("retires an archived stale owner when guarded deletion sees a successor", async () => {
    const runtime = { current: {} as GatewayRecoveryRuntime };
    const { entry, runs, callGateway, notifyContextEngineSubagentEnded, sweeper } =
      createHarness(runtime);
    entry.cleanup = "delete";
    entry.archiveAtMs = Date.now() - 1;
    entry.execution = {
      status: "terminal",
      startedAt: Date.now() - 60_000,
      endedAt: Date.now() - 55_000,
      outcome: { status: "ok" },
    };
    const successor = createSubagentRunRecord({
      runId: "successor-run",
      childSessionKey: entry.childSessionKey,
      requesterSessionKey: entry.requesterSessionKey,
      requesterDisplayKey: entry.requesterDisplayKey,
      task: "current successor",
      cleanup: "keep",
      generation: 2,
      createdAt: Date.now(),
      startedAt: Date.now(),
    });
    entry.generation = 1;
    runs.set(successor.runId, successor);
    getAgentRunContext.mockImplementation((runId: string) =>
      runId === successor.runId ? {} : undefined,
    );
    callGateway.mockImplementation(async (request) => {
      if (request.method !== "sessions.delete") {
        return {};
      }
      killSessionEntry.current = {
        sessionId: "successor-session",
        lifecycleRevision: "successor-revision",
        updatedAt: Date.now(),
      };
      throw Object.assign(new Error("session changed"), {
        name: "GatewayClientRequestError",
        gatewayCode: "INVALID_REQUEST",
        details: { reason: "session-changed" },
      });
    });

    await sweeper.sweepOnce();

    expect(callGateway).toHaveBeenCalledWith({
      method: "sessions.delete",
      params: {
        key: entry.childSessionKey,
        deleteTranscript: true,
        emitLifecycleHooks: false,
        expectedSessionId: "session-id",
        expectedLifecycleRevision: "session-revision",
      },
      timeoutMs: 10_000,
    });
    expect(runs.has(entry.runId)).toBe(false);
    expect(runs.get(successor.runId)).toBe(successor);
    expect(notifyContextEngineSubagentEnded).not.toHaveBeenCalled();
  });

  it("re-arms a sweep request that arrives while the owner pass is active", async () => {
    const runtime = { current: {} as GatewayRecoveryRuntime };
    let release!: () => void;
    recoverRow
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = () => resolve({ status: "handled" });
          }),
      )
      .mockResolvedValue({ status: "handled" });
    const { sweeper } = createHarness(runtime);

    const first = sweeper.runTick();
    await vi.waitFor(() => expect(recoverRow).toHaveBeenCalledOnce());
    await sweeper.runTick();
    release();
    await first;
    await vi.advanceTimersByTimeAsync(0);

    expect(recoverRow).toHaveBeenCalledTimes(2);
    sweeper.reset();
  });

  it("releases the owner lane after an unexpected pass failure", async () => {
    const runtime = { current: {} as GatewayRecoveryRuntime };
    recoverRow
      .mockRejectedValueOnce(new Error("unexpected recovery failure"))
      .mockResolvedValue({ status: "handled" });
    const { sweeper, warn } = createHarness(runtime);

    await sweeper.runTick();
    await sweeper.runTick();

    expect(recoverRow).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith("subagent run sweep failed: unexpected recovery failure");
    sweeper.reset();
  });
});

describe("superseded subagent retirement", () => {
  it("restores the registry row when durable deletion fails", async () => {
    const entry = run();
    const runs = new Map([[entry.runId, entry]]);
    const clearPendingLifecycleError = vi.fn();

    await expect(
      retireSupersededSubagentRun({
        runId: entry.runId,
        entry,
        runs,
        clearPendingLifecycleError,
        persistOrThrow: () => {
          throw new Error("registry deletion failed");
        },
      }),
    ).rejects.toThrow("registry deletion failed");

    expect(runs.get(entry.runId)).toBe(entry);
    expect(clearPendingLifecycleError).not.toHaveBeenCalled();
  });

  it("clears lifecycle errors only after durable deletion succeeds", async () => {
    const entry = run();
    const runs = new Map([[entry.runId, entry]]);
    const clearPendingLifecycleError = vi.fn();
    const persistOrThrow = vi.fn();

    await retireSupersededSubagentRun({
      runId: entry.runId,
      entry,
      runs,
      clearPendingLifecycleError,
      persistOrThrow,
    });

    expect(runs.has(entry.runId)).toBe(false);
    expect(persistOrThrow).toHaveBeenCalledWith(entry.runId);
    expect(clearPendingLifecycleError).toHaveBeenCalledWith(entry.runId);
  });
});
