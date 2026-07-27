// Bridges embedded-runner execution milestones onto the diagnostic bus as
// session-correlated run.execution_phase events, so external status surfaces
// can observe turn startup without a control-UI subscription.
import {
  areDiagnosticsEnabledForProcess,
  emitDiagnosticEvent,
  type DiagnosticMemoryUsage,
} from "../../../infra/diagnostic-events.js";
import type { RunEmbeddedAgentParams } from "./params.js";

type ExecutionPhaseCallback = NonNullable<RunEmbeddedAgentParams["onExecutionPhase"]>;
type SessionIdChangedCallback = NonNullable<RunEmbeddedAgentParams["onSessionIdChanged"]>;

type ExecutionPhaseParams = Pick<
  RunEmbeddedAgentParams,
  "onExecutionPhase" | "onSessionIdChanged" | "runId" | "sessionId" | "sessionKey"
>;

// A phase snapshot must never make diagnostics a new failure mode for a run.
function processMemoryUsageSnapshot(): DiagnosticMemoryUsage | undefined {
  try {
    const memory = process.memoryUsage();
    return {
      rssBytes: memory.rss,
      heapTotalBytes: memory.heapTotal,
      heapUsedBytes: memory.heapUsed,
      externalBytes: memory.external,
      arrayBuffersBytes: memory.arrayBuffers,
    };
  } catch {
    return undefined;
  }
}

/**
 * Wraps params.onExecutionPhase so every phase transition also emits a
 * run.execution_phase diagnostic event. Applied once at the runner entry;
 * downstream call sites all read the forwarded callback. Session compaction
 * can rotate the session id mid-run, so the wrapper tracks the current id via
 * onSessionIdChanged instead of capturing the initial value. The returned
 * params always carry both callbacks (the wrapper installs them), so callers
 * can invoke them unconditionally.
 */
export function withExecutionPhaseDiagnostics<T extends ExecutionPhaseParams>(
  params: T,
): T & { onExecutionPhase: ExecutionPhaseCallback; onSessionIdChanged: SessionIdChangedCallback } {
  const forwardPhase = params.onExecutionPhase;
  const forwardSessionIdChanged = params.onSessionIdChanged;
  let currentSessionId = params.sessionId;
  const onSessionIdChanged: SessionIdChangedCallback = (sessionId) => {
    currentSessionId = sessionId;
    forwardSessionIdChanged?.(sessionId);
  };
  const onExecutionPhase: ExecutionPhaseCallback = (info) => {
    if (areDiagnosticsEnabledForProcess()) {
      emitDiagnosticEvent({
        type: "run.execution_phase",
        runId: params.runId,
        sessionId: currentSessionId,
        sessionKey: params.sessionKey,
        ...info,
        memory: processMemoryUsageSnapshot(),
      });
    }
    forwardPhase?.(info);
  };
  return { ...params, onExecutionPhase, onSessionIdChanged };
}
