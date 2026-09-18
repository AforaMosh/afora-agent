// Subagent completion-wait abort classification tests: an abort reported by the
// wait path must cross-check the persisted session entry before filing a kill,
// so a proven completion is never reclassified as a kill.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import {
  SUBAGENT_ENDED_REASON_COMPLETE,
  SUBAGENT_ENDED_REASON_KILLED,
} from "./subagent-lifecycle-events.js";

const mocks = vi.hoisted(() => ({
  waitForAgentRun: vi.fn(),
  resolveSubagentSessionCompletion: vi.fn(),
}));

vi.mock("../../../config/config.js", () => ({
  getRuntimeConfig: () => ({}),
}));
vi.mock("../../../gateway/call.js", () => ({
  callGateway: vi.fn(),
}));
vi.mock("../../run-wait.js", () => ({
  waitForAgentRun: mocks.waitForAgentRun,
  isRecoverableAgentWaitError: () => false,
}));
vi.mock("../announce/subagent-announce-output.js", () => ({
  withSubagentOutcomeTiming: (outcome: unknown) => outcome,
}));

import { SubagentWaitManager } from "./subagent-registry-run-wait.js";
import type { SubagentCompletionRequest, SubagentRunRecord } from "./subagent-registry.types.js";

function createHarness() {
  const entry = createSubagentRunRecord({
    runId: "wait-abort-run",
    childSessionKey: "agent:main:subagent:wait-abort",
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "finish before the teardown abort",
    cleanup: "keep",
    createdAt: Date.now() - 60_000,
    startedAt: Date.now() - 55_000,
  });
  const runs = new Map<string, SubagentRunRecord>([[entry.runId, entry]]);
  const completeSubagentRun = vi.fn(async (_params: SubagentCompletionRequest) => {});
  const manager = new SubagentWaitManager({
    runs,
    getRunsForChildSession: () => [],
    resumedRuns: new Set(),
    persist: vi.fn(),
    persistOrThrow: vi.fn(),
    callGateway: vi.fn() as never,
    getRuntimeConfig: () => ({}) as never,
    ensureListener: vi.fn(),
    startSweeper: vi.fn(),
    stopSweeper: vi.fn(),
    resumeSubagentRun: vi.fn(),
    clearPendingLifecycleError: vi.fn(),
    clearPendingLifecycleTimeout: vi.fn(),
    resolveSubagentWaitTimeoutMs: () => 60_000,
    scheduleSweep: vi.fn(),
    resolveSubagentSessionCompletion: mocks.resolveSubagentSessionCompletion,
    resolveSubagentSessionStartedAt: vi.fn(() => undefined),
    notifyContextEngineSubagentEnded: vi.fn(async () => {}),
    completeCleanupBookkeeping: vi.fn(),
    completeSubagentRun,
    resolveSubagentTask: vi.fn(() => ({ lookup: "unavailable" }) as never),
  });
  return { entry, completeSubagentRun, manager };
}

describe("subagent completion wait abort classification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("adopts a landed session completion instead of filing a kill", async () => {
    const { entry, completeSubagentRun, manager } = createHarness();
    const endedAt = Date.now();
    mocks.waitForAgentRun.mockResolvedValue({
      status: "error",
      error: "run aborted",
      stopReason: "aborted",
      startedAt: entry.execution.startedAt,
      endedAt,
    });
    mocks.resolveSubagentSessionCompletion.mockReturnValue({
      startedAt: entry.execution.startedAt,
      endedAt: endedAt - 1_000,
      outcome: { status: "ok" },
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
    });

    await manager.waitForSubagentCompletion(entry.runId, 60_000, entry);

    expect(completeSubagentRun).toHaveBeenCalledTimes(1);
    expect(completeSubagentRun).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: entry.runId,
        outcome: { status: "ok" },
        reason: SUBAGENT_ENDED_REASON_COMPLETE,
      }),
    );
  });

  it("files a kill when the session entry carries no completion", async () => {
    const { entry, completeSubagentRun, manager } = createHarness();
    const endedAt = Date.now();
    mocks.waitForAgentRun.mockResolvedValue({
      status: "error",
      error: "run aborted",
      stopReason: "aborted",
      startedAt: entry.execution.startedAt,
      endedAt,
    });
    mocks.resolveSubagentSessionCompletion.mockReturnValue(null);

    await manager.waitForSubagentCompletion(entry.runId, 60_000, entry);

    expect(completeSubagentRun).toHaveBeenCalledTimes(1);
    expect(completeSubagentRun).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: entry.runId,
        reason: SUBAGENT_ENDED_REASON_KILLED,
      }),
    );
    const call = completeSubagentRun.mock.calls[0]?.[0] as SubagentCompletionRequest;
    expect(call.outcome).toMatchObject({ status: "error", error: "subagent run terminated" });
  });
});
