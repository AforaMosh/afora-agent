// Run-scoped task status update policy tests: a proven completion is never
// overwritten by a later failure, timeout, cancellation or loss, while a
// premature failure or timeout stays correctable back to succeeded.
import { describe, expect, it } from "vitest";
import { SUBAGENT_KILL_TASK_ERROR } from "./detached-task-runtime-contract.js";
import { shouldApplyRunScopedStatusUpdate } from "./task-registry-common.js";
import type { TaskStatus } from "./task-registry.types.js";

function update(params: {
  currentStatus: TaskStatus;
  nextStatus: TaskStatus;
  currentError?: string;
  nextError?: string;
  currentEndedAt?: number;
  nextEndedAt?: number;
}): boolean {
  return shouldApplyRunScopedStatusUpdate({
    currentRuntime: "subagent",
    currentChildSessionKey: "agent:worker:subagent:child",
    ...params,
  });
}

describe("shouldApplyRunScopedStatusUpdate", () => {
  it.each(["failed", "timed_out", "lost"] as const)(
    "keeps a proven success when a later %s arrives",
    (nextStatus) => {
      expect(
        update({
          currentStatus: "succeeded",
          currentEndedAt: 200,
          nextStatus,
          nextEndedAt: 300,
          nextError: nextStatus === "failed" ? "late teardown failure" : undefined,
        }),
      ).toBe(false);
    },
  );

  it("keeps a proven success when a stable cancellation arrives later", () => {
    expect(
      update({
        currentStatus: "succeeded",
        currentEndedAt: 200,
        nextStatus: "cancelled",
        nextEndedAt: 300,
        nextError: "Cancelled by operator.",
      }),
    ).toBe(false);
  });

  it.each(["failed", "timed_out"] as const)(
    "lets a later success correct a premature %s",
    (currentStatus) => {
      expect(
        update({
          currentStatus,
          currentEndedAt: 200,
          currentError: "registry settled before the session entry landed",
          nextStatus: "succeeded",
          nextEndedAt: 300,
        }),
      ).toBe(true);
    },
  );

  it("does not rewrite one failure class with another", () => {
    expect(
      update({ currentStatus: "failed", currentEndedAt: 200, nextStatus: "timed_out" }),
    ).toBe(false);
  });

  it("still applies terminal updates to a non-terminal task", () => {
    expect(update({ currentStatus: "running", nextStatus: "failed" })).toBe(true);
    expect(update({ currentStatus: "queued", nextStatus: "succeeded" })).toBe(true);
  });

  it("still blocks the provisional kill marker against a terminal task", () => {
    expect(
      update({
        currentStatus: "succeeded",
        currentEndedAt: 200,
        nextStatus: "cancelled",
        nextError: SUBAGENT_KILL_TASK_ERROR,
      }),
    ).toBe(false);
  });

  it("still lets a provisional kill be corrected by its own completion", () => {
    expect(
      update({
        currentStatus: "cancelled",
        currentError: SUBAGENT_KILL_TASK_ERROR,
        currentEndedAt: 200,
        nextStatus: "succeeded",
        nextEndedAt: 201,
      }),
    ).toBe(true);
  });

  it("keeps the legacy failure-wins rule for non-subagent runtimes", () => {
    // Delivery-contract failures must still upgrade a lifecycle success and
    // must stay sticky against a late success for embedded/CLI runtimes.
    expect(
      shouldApplyRunScopedStatusUpdate({
        currentStatus: "succeeded",
        currentRuntime: "cli",
        currentEndedAt: 200,
        nextStatus: "failed",
        nextEndedAt: 300,
        nextError: "delivery failed",
      }),
    ).toBe(true);
    expect(
      shouldApplyRunScopedStatusUpdate({
        currentStatus: "failed",
        currentRuntime: "cli",
        currentEndedAt: 200,
        currentError: "delivery failed",
        nextStatus: "succeeded",
        nextEndedAt: 300,
      }),
    ).toBe(false);
  });
});
