import { isFastTestRuntimeEnv } from "../../../infra/env.js";
import {
  SUBAGENT_ENDED_REASON_COMPLETE,
  SUBAGENT_ENDED_REASON_ERROR,
  SUBAGENT_ENDED_REASON_KILLED,
} from "./subagent-lifecycle-events.js";
import type { SubagentCompletionRequest, SubagentRunRecord } from "./subagent-registry.types.js";

const LIFECYCLE_RETRY_GRACE_MS = 15_000;
// The abort-classified kill grace matches the retry grace in production; fast
// test runtimes shrink it the way other registry delays already are.
const LIFECYCLE_KILL_GRACE_MS = isFastTestRuntimeEnv() ? 25 : LIFECYCLE_RETRY_GRACE_MS;
const PENDING_LIFECYCLE_TERMINAL_TTL_MS = 5 * 60_000;

type PendingLifecycleKind = "error" | "timeout" | "kill";

type PendingLifecycleTerminal = {
  kind: PendingLifecycleKind;
  timer: NodeJS.Timeout;
  endedAt: number;
  startedAt?: number;
  error?: string;
  terminalReply?: SubagentCompletionRequest["terminalReply"];
};

export function createPendingLifecycleScheduler(params: {
  runs: Map<string, SubagentRunRecord>;
  completeInBackground: (completion: SubagentCompletionRequest, source: string) => void;
}) {
  const pendingByRunId = new Map<string, PendingLifecycleTerminal>();

  function clearKind(runId: string, kind?: PendingLifecycleKind) {
    const pending = pendingByRunId.get(runId);
    if (!pending || (kind && pending.kind !== kind)) {
      return;
    }
    clearTimeout(pending.timer);
    pendingByRunId.delete(runId);
  }

  function clearAll() {
    pendingByRunId.forEach(({ timer }) => clearTimeout(timer));
    pendingByRunId.clear();
  }

  function schedule(
    kind: PendingLifecycleKind,
    scheduleParams: {
      runId: string;
      endedAt: number;
      startedAt?: number;
      error?: string;
      terminalReply?: SubagentCompletionRequest["terminalReply"];
    },
  ) {
    clearKind(scheduleParams.runId);
    const timer = setTimeout(() => {
      const pending = pendingByRunId.get(scheduleParams.runId);
      if (!pending || pending.timer !== timer) {
        return;
      }
      pendingByRunId.delete(scheduleParams.runId);
      const entry = params.runs.get(scheduleParams.runId);
      if (!entry) {
        return;
      }
      if (
        kind === "timeout"
          ? entry.execution.outcome?.status === "ok" || entry.pauseReason === "sessions_yield"
          : entry.endedReason === SUBAGENT_ENDED_REASON_COMPLETE ||
            entry.execution.outcome?.status === "ok"
      ) {
        // A completion landed during the grace window; a late error, timeout,
        // or abort classification must not overwrite it.
        return;
      }
      params.completeInBackground(
        {
          runId: scheduleParams.runId,
          endedAt: pending.endedAt,
          outcome:
            kind === "timeout"
              ? { status: "timeout" }
              : { status: "error", error: pending.error },
          reason:
            kind === "timeout"
              ? SUBAGENT_ENDED_REASON_COMPLETE
              : kind === "kill"
                ? SUBAGENT_ENDED_REASON_KILLED
                : SUBAGENT_ENDED_REASON_ERROR,
          sendFarewell: true,
          accountId: entry.requesterOrigin?.accountId,
          triggerCleanup: true,
          startedAt: pending.startedAt,
          terminalReply: pending.terminalReply,
        },
        `lifecycle-${kind}-grace`,
      );
    }, kind === "kill" ? LIFECYCLE_KILL_GRACE_MS : LIFECYCLE_RETRY_GRACE_MS);
    timer.unref?.();
    pendingByRunId.set(scheduleParams.runId, { ...scheduleParams, kind, timer });
  }

  return {
    clear: clearKind,
    clearError: (runId: string) => clearKind(runId, "error"),
    clearTimeout: (runId: string) => clearKind(runId, "timeout"),
    clearAll,
    scheduleError: (scheduleParams: Parameters<typeof schedule>[1]) =>
      schedule("error", scheduleParams),
    scheduleTimeout: (scheduleParams: Parameters<typeof schedule>[1]) =>
      schedule("timeout", scheduleParams),
    scheduleKill: (scheduleParams: Parameters<typeof schedule>[1]) =>
      schedule("kill", scheduleParams),
    sweepExpired(now: number) {
      for (const [runId, pending] of pendingByRunId) {
        if (now - pending.endedAt > PENDING_LIFECYCLE_TERMINAL_TTL_MS) {
          clearKind(runId, pending.kind);
        }
      }
    },
  };
}
