// Lifecycle listener kill-classification tests: an abort-stopReason event must
// cross-check the persisted session entry and wait out a grace window before a
// kill is committed, so a proven or in-flight completion always wins.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEventPayload } from "../../../infra/agent-events.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import {
  SUBAGENT_ENDED_REASON_COMPLETE,
  SUBAGENT_ENDED_REASON_KILLED,
} from "./subagent-lifecycle-events.js";

const mocks = vi.hoisted(() => ({
  resolveSubagentSessionCompletion: vi.fn(),
  markSubagentRunPausedAfterYield: vi.fn(() => false),
}));

vi.mock("./subagent-session-reconciliation.js", () => ({
  resolveSubagentSessionCompletion: mocks.resolveSubagentSessionCompletion,
}));
vi.mock("./subagent-registry-run-manager.js", () => ({
  markSubagentRunPausedAfterYield: mocks.markSubagentRunPausedAfterYield,
}));

import { createSubagentRegistryListener } from "./subagent-registry-listener.js";
import { createPendingLifecycleScheduler } from "./subagent-registry-pending-lifecycle.js";
import type { SubagentCompletionRequest, SubagentRunRecord } from "./subagent-registry.types.js";

function createHarness() {
  const entry = createSubagentRunRecord({
    runId: "abort-race-run",
    childSessionKey: "agent:main:subagent:abort-race",
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "finish before the teardown abort",
    cleanup: "keep",
    createdAt: Date.now() - 60_000,
    startedAt: Date.now() - 55_000,
  });
  const runs = new Map<string, SubagentRunRecord>([[entry.runId, entry]]);
  const completeSubagentRunWithRecovery = vi.fn(
    async (_params: SubagentCompletionRequest, _source: string) => {},
  );
  const pendingLifecycle = createPendingLifecycleScheduler({
    runs,
    completeInBackground: (params, source) => {
      void completeSubagentRunWithRecovery(params, source);
    },
  });
  let handler: ((event: AgentEventPayload) => void) | undefined;
  const listener = createSubagentRegistryListener({
    runs,
    pendingLifecycle,
    onAgentEvent: (callback) => {
      handler = callback;
      return () => undefined;
    },
    persist: vi.fn(),
    refreshFrozenResultFromSession: vi.fn(async () => {}),
    completeSubagentRunWithRecovery,
    warn: vi.fn(),
  });
  listener.ensure();
  const emit = (event: Record<string, unknown>) =>
    handler?.(event as unknown as AgentEventPayload);
  return { entry, completeSubagentRunWithRecovery, pendingLifecycle, emit };
}

async function flushHandler() {
  // The listener body is fire-and-forget; let its promise chain settle.
  for (let i = 0; i < 5; i += 1) {
    await vi.advanceTimersByTimeAsync(0);
  }
}

describe("subagent registry listener abort classification", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("adopts a landed session completion instead of committing a kill", async () => {
    const { entry, completeSubagentRunWithRecovery, pendingLifecycle, emit } = createHarness();
    const endedAt = Date.now();
    mocks.resolveSubagentSessionCompletion.mockReturnValue({
      startedAt: entry.execution.startedAt,
      endedAt: endedAt - 1_000,
      outcome: { status: "ok" },
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
    });

    emit({
      stream: "lifecycle",
      runId: entry.runId,
      ts: endedAt,
      data: {
        phase: "end",
        startedAt: entry.execution.startedAt,
        endedAt,
        stopReason: "aborted",
      },
    });
    await flushHandler();

    expect(completeSubagentRunWithRecovery).toHaveBeenCalledTimes(1);
    expect(completeSubagentRunWithRecovery).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: entry.runId,
        outcome: { status: "ok" },
        reason: SUBAGENT_ENDED_REASON_COMPLETE,
      }),
      "lifecycle-killed-event-session-completion",
    );

    await vi.advanceTimersByTimeAsync(30_000);
    expect(completeSubagentRunWithRecovery).toHaveBeenCalledTimes(1);
    pendingLifecycle.clearAll();
  });

  it("commits a genuine kill only after the grace window", async () => {
    const { entry, completeSubagentRunWithRecovery, pendingLifecycle, emit } = createHarness();
    mocks.resolveSubagentSessionCompletion.mockReturnValue(null);
    const endedAt = Date.now();

    emit({
      stream: "lifecycle",
      runId: entry.runId,
      ts: endedAt,
      data: {
        phase: "end",
        startedAt: entry.execution.startedAt,
        endedAt,
        stopReason: "aborted",
      },
    });
    await flushHandler();

    // No immediate commit: a completion event can still be in flight.
    expect(completeSubagentRunWithRecovery).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(15_001);
    expect(completeSubagentRunWithRecovery).toHaveBeenCalledTimes(1);
    expect(completeSubagentRunWithRecovery).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: entry.runId,
        outcome: { status: "error", error: "subagent run terminated" },
        reason: SUBAGENT_ENDED_REASON_KILLED,
      }),
      "lifecycle-kill-grace",
    );
    pendingLifecycle.clearAll();
  });

  it("drops the pending kill when the completion event lands during the grace", async () => {
    const { entry, completeSubagentRunWithRecovery, pendingLifecycle, emit } = createHarness();
    mocks.resolveSubagentSessionCompletion.mockReturnValue(null);
    const endedAt = Date.now();

    emit({
      stream: "lifecycle",
      runId: entry.runId,
      ts: endedAt,
      data: {
        phase: "end",
        startedAt: entry.execution.startedAt,
        endedAt,
        stopReason: "aborted",
      },
    });
    await flushHandler();
    expect(completeSubagentRunWithRecovery).not.toHaveBeenCalled();

    emit({
      stream: "lifecycle",
      runId: entry.runId,
      ts: endedAt + 2_000,
      data: {
        phase: "end",
        startedAt: entry.execution.startedAt,
        endedAt: endedAt + 2_000,
      },
    });
    await flushHandler();

    expect(completeSubagentRunWithRecovery).toHaveBeenCalledTimes(1);
    expect(completeSubagentRunWithRecovery).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: entry.runId,
        outcome: { status: "ok" },
        reason: SUBAGENT_ENDED_REASON_COMPLETE,
      }),
      "lifecycle-ok-event",
    );

    await vi.advanceTimersByTimeAsync(30_000);
    expect(completeSubagentRunWithRecovery).toHaveBeenCalledTimes(1);
    pendingLifecycle.clearAll();
  });
});
