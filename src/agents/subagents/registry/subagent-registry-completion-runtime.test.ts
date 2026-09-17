// Interrupted-recovery finalization tests: a recovery terminal projection must
// adopt the child session's landed terminal status (including a proven
// completion) instead of inventing an error over it.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import {
  SUBAGENT_ENDED_REASON_COMPLETE,
  SUBAGENT_ENDED_REASON_ERROR,
} from "./subagent-lifecycle-events.js";

const reconciliation = vi.hoisted(() => ({
  loadSubagentSessionEntry: vi.fn(),
  resolveCompletionFromSessionEntry: vi.fn(),
}));

vi.mock("./subagent-session-reconciliation.js", () => reconciliation);

import { createSubagentRegistryCompletionRuntime } from "./subagent-registry-completion-runtime.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

function createHarness() {
  const entry = createSubagentRunRecord({
    runId: "interrupted-run",
    childSessionKey: "agent:main:subagent:interrupted",
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "recover after restart",
    cleanup: "keep",
    createdAt: Date.now() - 60_000,
    startedAt: Date.now() - 55_000,
  });
  const runs = new Map<string, SubagentRunRecord>([[entry.runId, entry]]);
  const completeSubagentRun = vi.fn(
    async (params: {
      endedAt?: number;
      outcome?: SubagentRunRecord["execution"]["outcome"];
      reason?: SubagentRunRecord["endedReason"];
    }) => {
      entry.execution = {
        ...entry.execution,
        status: "terminal",
        endedAt: params.endedAt ?? Date.now(),
        outcome: params.outcome,
      };
      entry.endedReason = params.reason;
    },
  );
  const runtime = createSubagentRegistryCompletionRuntime({
    runs,
    resumed: new Set(),
    retryTimers: new Set(),
    completeSubagentRun,
    scheduleSweep: vi.fn(),
    resumeRun: vi.fn(),
    warn: vi.fn(),
  });
  return { entry, completeSubagentRun, runtime };
}

describe("finalizeInterruptedSubagentRun", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("adopts a landed session completion instead of finalizing as an error", async () => {
    const { entry, completeSubagentRun, runtime } = createHarness();
    reconciliation.resolveCompletionFromSessionEntry.mockReturnValue({
      startedAt: entry.execution.startedAt,
      endedAt: Date.now() - 1_000,
      outcome: { status: "ok" },
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
    });

    const finalized = await runtime.finalizeInterruptedSubagentRun({
      runId: entry.runId,
      expectedEntry: entry,
      error:
        "subagent restart recovery was abandoned after an ambiguous Gateway restart; " +
        "automatic replay was suppressed to avoid duplicate side effects",
    });

    expect(finalized).toBe(1);
    expect(completeSubagentRun).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: entry.runId,
        expectedEntry: entry,
        outcome: { status: "ok" },
        reason: SUBAGENT_ENDED_REASON_COMPLETE,
        recoverInterrupted: true,
        triggerCleanup: true,
      }),
    );
    const call = completeSubagentRun.mock.calls[0]?.[0] as { outcome: { error?: string } };
    expect(call.outcome.error).toBeUndefined();
  });

  it("finalizes as an error when the session entry carries no terminal status", async () => {
    const { entry, completeSubagentRun, runtime } = createHarness();
    reconciliation.resolveCompletionFromSessionEntry.mockReturnValue(null);

    const finalized = await runtime.finalizeInterruptedSubagentRun({
      runId: entry.runId,
      expectedEntry: entry,
      error: "stale aborted subagent run not resumed (7200s old, exceeds stale-run window)",
    });

    expect(finalized).toBe(1);
    expect(completeSubagentRun).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: entry.runId,
        outcome: {
          status: "error",
          error: "stale aborted subagent run not resumed (7200s old, exceeds stale-run window)",
        },
        reason: SUBAGENT_ENDED_REASON_ERROR,
      }),
    );
  });
});
