import { describe, expect, it, vi } from "vitest";
import type { CronJob, CronRunStatus } from "../types.js";
import { createCronServiceState } from "./state.js";
import { collectRunnableJobs, isRunnableJob } from "./timer-runnable.js";

const ORIGINAL_AT_MS = Date.parse("2026-07-27T10:00:00.000Z");
const FUTURE_AT_MS = ORIGINAL_AT_MS + 60_000;

function createRunnableState(params: {
  lastRunStatus?: CronRunStatus;
  lastRunAtMs?: number;
  nextRunAtMs?: number;
  forcePreservedNextRunAtMs?: number;
}) {
  const nextRunAtMs = params.nextRunAtMs ?? ORIGINAL_AT_MS;
  const job: CronJob = {
    id: "one-shot-runnable-regression",
    name: "one-shot runnable regression",
    enabled: true,
    deleteAfterRun: true,
    createdAtMs: ORIGINAL_AT_MS - 60_000,
    updatedAtMs: ORIGINAL_AT_MS - 60_000,
    schedule: { kind: "at", at: new Date(nextRunAtMs).toISOString() },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "run exactly once" },
    delivery: { mode: "none" },
    state: {
      nextRunAtMs,
      ...(params.lastRunStatus ? { lastRunStatus: params.lastRunStatus } : {}),
      ...(params.lastRunAtMs === undefined ? {} : { lastRunAtMs: params.lastRunAtMs }),
      ...(params.forcePreservedNextRunAtMs === undefined
        ? {}
        : { forcePreservedNextRunAtMs: params.forcePreservedNextRunAtMs }),
    },
  };
  const state = createCronServiceState({
    cronEnabled: true,
    storePath: "/unused/cron-runnable-regression.sqlite",
    nowMs: () => FUTURE_AT_MS,
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
  });
  state.store = { version: 1, jobs: [job] };
  return { job, state };
}

describe("cron one-shot runnable ownership", () => {
  it.each(["ok", "error", "skipped"] as const)(
    "does not re-run a completed %s one-shot on an ordinary timer tick",
    (lastRunStatus) => {
      const { job, state } = createRunnableState({
        lastRunStatus,
        lastRunAtMs: ORIGINAL_AT_MS,
      });

      expect(collectRunnableJobs(state, FUTURE_AT_MS)).toEqual([]);
      expect(isRunnableJob({ state, job, nowMs: FUTURE_AT_MS })).toBe(false);
    },
  );

  it("runs a fresh one-shot when its scheduled occurrence becomes due", () => {
    const { job, state } = createRunnableState({});

    expect(collectRunnableJobs(state, FUTURE_AT_MS)).toEqual([job]);
  });

  it("runs a one-shot explicitly rescheduled after its successful occurrence", () => {
    const { job, state } = createRunnableState({
      lastRunStatus: "ok",
      lastRunAtMs: ORIGINAL_AT_MS,
      nextRunAtMs: FUTURE_AT_MS,
    });

    expect(collectRunnableJobs(state, FUTURE_AT_MS)).toEqual([job]);
  });

  it("runs the original future occurrence after a skipped forced manual run", () => {
    const { job, state } = createRunnableState({
      lastRunStatus: "skipped",
      lastRunAtMs: ORIGINAL_AT_MS,
      nextRunAtMs: FUTURE_AT_MS,
      forcePreservedNextRunAtMs: FUTURE_AT_MS,
    });

    expect(collectRunnableJobs(state, FUTURE_AT_MS)).toEqual([job]);
  });

  it("runs a retry scheduled after a transient one-shot failure", () => {
    const { job, state } = createRunnableState({
      lastRunStatus: "error",
      lastRunAtMs: ORIGINAL_AT_MS,
      nextRunAtMs: FUTURE_AT_MS,
    });

    expect(collectRunnableJobs(state, FUTURE_AT_MS)).toEqual([job]);
  });
});
