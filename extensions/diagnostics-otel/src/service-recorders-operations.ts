import { SpanStatusCode } from "@opentelemetry/api";
import {
  normalizeDiagnosticValue,
  normalizeDiagnosticLane,
} from "afora-agent/plugin-sdk/diagnostic-runtime";
import { redactSensitiveText } from "../api.js";
import type {
  DiagnosticEventMetadata,
  DiagnosticEventPayload,
  DiagnosticEventPrivateData,
} from "../api.js";
import { normalizeOtelErrorMessage } from "./service-content-normalization.js";
import type { DiagnosticsRecorderRuntime } from "./service-recorder-runtime.js";
import type { SessionRecoveryDiagnosticEvent, TalkDiagnosticEvent } from "./service-types.js";

export function createOperationsRecorders(runtime: DiagnosticsRecorderRuntime) {
  const {
    durationHistogram,
    queueDepthHistogram,
    queueWaitHistogram,
    laneEnqueueCounter,
    laneDequeueCounter,
    sessionStateCounter,
    sessionTurnCreatedCounter,
    sessionStuckCounter,
    sessionStuckAgeHistogram,
    sessionRecoveryRequestedCounter,
    sessionRecoveryCompletedCounter,
    sessionRecoveryAgeHistogram,
    talkEventCounter,
    talkEventDurationHistogram,
    talkAudioBytesHistogram,
    runAttemptCounter,
    toolLoopCounter,
    memoryRssHistogram,
    memoryHeapUsedHistogram,
    memoryHeapTotalHistogram,
    memoryExternalHistogram,
    memoryArrayBuffersHistogram,
    memoryPressureCounter,
    asyncQueueDroppedCounter,
    tracer,
    activeTrustedSpans,
    spanWithDuration,
    trustedTraceContext,
    activeTrustedParentContext,
    setSpanAttrs,
    completeTrackedLifecycleSpan,
    addRunAttrs,
    tracesEnabled,
  } = runtime;

  const recordLaneEnqueue = (
    evt: Extract<DiagnosticEventPayload, { type: "queue.lane.enqueue" }>,
  ) => {
    const attrs = { "afora.lane": normalizeDiagnosticLane(evt.lane) };
    laneEnqueueCounter.add(1, attrs);
    queueDepthHistogram.record(evt.queueSize, attrs);
  };

  const recordLaneDequeue = (
    evt: Extract<DiagnosticEventPayload, { type: "queue.lane.dequeue" }>,
  ) => {
    const attrs = { "afora.lane": normalizeDiagnosticLane(evt.lane) };
    laneDequeueCounter.add(1, attrs);
    queueDepthHistogram.record(evt.queueSize, attrs);
    if (typeof evt.waitMs === "number") {
      queueWaitHistogram.record(evt.waitMs, attrs);
    }
  };

  const recordSessionState = (evt: Extract<DiagnosticEventPayload, { type: "session.state" }>) => {
    const attrs: Record<string, string> = { "afora.state": evt.state };
    if (evt.reason) {
      attrs["afora.reason"] = redactSensitiveText(evt.reason);
    }
    sessionStateCounter.add(1, attrs);
  };

  const recordSessionTurnCreated = (
    evt: Extract<DiagnosticEventPayload, { type: "session.turn.created" }>,
  ) => {
    sessionTurnCreatedCounter.add(1, {
      "afora.agent": normalizeDiagnosticValue(evt.agentId, "unknown"),
      "afora.channel": normalizeDiagnosticValue(evt.channel, "unknown"),
      "afora.trigger": evt.trigger,
    });
  };

  const recordSessionStuck = (evt: Extract<DiagnosticEventPayload, { type: "session.stuck" }>) => {
    const attrs: Record<string, string> = { "afora.state": evt.state };
    sessionStuckCounter.add(1, attrs);
    if (typeof evt.ageMs === "number") {
      sessionStuckAgeHistogram.record(evt.ageMs, attrs);
    }
    if (!tracesEnabled) {
      return;
    }
    const spanAttrs: Record<string, string | number> = { ...attrs };
    spanAttrs["afora.queueDepth"] = evt.queueDepth ?? 0;
    spanAttrs["afora.ageMs"] = evt.ageMs;
    const span = tracer.startSpan("afora.session.stuck", { attributes: spanAttrs });
    span.setStatus({ code: SpanStatusCode.ERROR, message: "session stuck" });
    span.end();
  };

  const sessionRecoveryAttrs = (evt: SessionRecoveryDiagnosticEvent) => {
    const attrs: Record<string, string> = { "afora.state": evt.state };
    if (evt.reason) {
      attrs["afora.reason"] = redactSensitiveText(evt.reason);
    }
    if (evt.activeWorkKind) {
      attrs["afora.active_work_kind"] = evt.activeWorkKind;
    }
    return attrs;
  };

  const recordSessionRecoveryRequested = (
    evt: Extract<DiagnosticEventPayload, { type: "session.recovery.requested" }>,
  ) => {
    const attrs = sessionRecoveryAttrs(evt);
    attrs["afora.action"] = evt.allowActiveAbort ? "abort" : "recover";
    sessionRecoveryRequestedCounter.add(1, attrs);
    sessionRecoveryAgeHistogram.record(evt.ageMs, attrs);
  };

  const recordSessionRecoveryCompleted = (
    evt: Extract<DiagnosticEventPayload, { type: "session.recovery.completed" }>,
  ) => {
    const attrs = sessionRecoveryAttrs(evt);
    attrs["afora.status"] = evt.status;
    attrs["afora.action"] = normalizeDiagnosticValue(evt.action, "unknown");
    if (evt.outcomeReason) {
      attrs["afora.reason"] = redactSensitiveText(evt.outcomeReason);
    }
    sessionRecoveryCompletedCounter.add(1, attrs);
    sessionRecoveryAgeHistogram.record(evt.ageMs, attrs);
  };

  const talkEventAttrs = (evt: TalkDiagnosticEvent): Record<string, string> => ({
    "afora.talk.brain": normalizeDiagnosticValue(evt.brain),
    "afora.talk.event_type": normalizeDiagnosticValue(evt.talkEventType),
    "afora.talk.mode": normalizeDiagnosticValue(evt.mode),
    "afora.talk.provider": normalizeDiagnosticValue(evt.provider),
    "afora.talk.transport": normalizeDiagnosticValue(evt.transport),
  });

  const recordTalkEvent = (evt: TalkDiagnosticEvent, metadata: DiagnosticEventMetadata) => {
    if (!metadata.trusted) {
      return;
    }
    const attrs = talkEventAttrs(evt);
    talkEventCounter.add(1, attrs);
    if (typeof evt.durationMs === "number") {
      talkEventDurationHistogram.record(evt.durationMs, attrs);
    }
    if (typeof evt.byteLength === "number") {
      talkAudioBytesHistogram.record(evt.byteLength, attrs);
    }
  };

  const recordRunAttempt = (evt: Extract<DiagnosticEventPayload, { type: "run.attempt" }>) => {
    runAttemptCounter.add(1, { "afora.attempt": evt.attempt });
  };

  const toolLoopAttrs = (
    evt: Extract<DiagnosticEventPayload, { type: "tool.loop" }>,
  ): Record<string, string | number> => ({
    "afora.toolName": normalizeDiagnosticValue(evt.toolName, "tool"),
    "afora.loop.level": evt.level,
    "afora.loop.action": evt.action,
    "afora.loop.detector": evt.detector,
    "afora.loop.count": evt.count,
    ...(evt.pairedToolName
      ? { "afora.loop.paired_tool": normalizeDiagnosticValue(evt.pairedToolName, "tool") }
      : {}),
  });

  const recordToolLoop = (evt: Extract<DiagnosticEventPayload, { type: "tool.loop" }>) => {
    const attrs = toolLoopAttrs(evt);
    toolLoopCounter.add(1, attrs);
    if (!tracesEnabled) {
      return;
    }
    const span = spanWithDuration("afora.tool.loop", attrs, 0, { endTimeMs: evt.ts });
    if (evt.level === "critical" || evt.action === "block") {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: `${evt.detector}:${evt.action}`,
      });
    }
    span.end(evt.ts);
  };

  const recordMemoryUsageMetrics = (
    evt: Extract<
      DiagnosticEventPayload,
      { type: "diagnostic.memory.sample" | "diagnostic.memory.pressure" }
    >,
    attrs: Record<string, string> = {},
  ) => {
    memoryRssHistogram.record(evt.memory.rssBytes, attrs);
    memoryHeapUsedHistogram.record(evt.memory.heapUsedBytes, attrs);
    memoryHeapTotalHistogram.record(evt.memory.heapTotalBytes, attrs);
    memoryExternalHistogram.record(evt.memory.externalBytes, attrs);
    memoryArrayBuffersHistogram.record(evt.memory.arrayBuffersBytes, attrs);
  };

  const recordMemorySample = (
    evt: Extract<DiagnosticEventPayload, { type: "diagnostic.memory.sample" }>,
  ) => {
    recordMemoryUsageMetrics(evt);
  };

  const recordMemoryPressure = (
    evt: Extract<DiagnosticEventPayload, { type: "diagnostic.memory.pressure" }>,
  ) => {
    const attrs = {
      "afora.memory.level": evt.level,
      "afora.memory.reason": evt.reason,
    };
    memoryPressureCounter.add(1, attrs);
    recordMemoryUsageMetrics(evt, attrs);
    if (!tracesEnabled) {
      return;
    }
    const spanAttrs: Record<string, string | number | boolean> = {
      ...attrs,
      "afora.memory.rss_bytes": evt.memory.rssBytes,
      "afora.memory.heap_used_bytes": evt.memory.heapUsedBytes,
      "afora.memory.heap_total_bytes": evt.memory.heapTotalBytes,
      "afora.memory.external_bytes": evt.memory.externalBytes,
      "afora.memory.array_buffers_bytes": evt.memory.arrayBuffersBytes,
      ...(evt.thresholdBytes !== undefined
        ? { "afora.memory.threshold_bytes": evt.thresholdBytes }
        : {}),
      ...(evt.rssGrowthBytes !== undefined
        ? { "afora.memory.rss_growth_bytes": evt.rssGrowthBytes }
        : {}),
      ...(evt.windowMs !== undefined ? { "afora.memory.window_ms": evt.windowMs } : {}),
    };
    const span = spanWithDuration("afora.memory.pressure", spanAttrs, 0, {
      endTimeMs: evt.ts,
    });
    if (evt.level === "critical") {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: evt.reason,
      });
    }
    span.end(evt.ts);
  };

  const recordAsyncQueueDropped = (
    evt: Extract<DiagnosticEventPayload, { type: "diagnostic.async_queue.dropped" }>,
  ) => {
    asyncQueueDroppedCounter.add(evt.droppedEvents, {
      "afora.diagnostic.async_queue.drop_class": "total",
    });
    if (evt.droppedTrustedEvents !== undefined) {
      asyncQueueDroppedCounter.add(evt.droppedTrustedEvents, {
        "afora.diagnostic.async_queue.drop_class": "trusted",
      });
    }
    if (evt.droppedUntrustedEvents !== undefined) {
      asyncQueueDroppedCounter.add(evt.droppedUntrustedEvents, {
        "afora.diagnostic.async_queue.drop_class": "untrusted",
      });
    }
    if (evt.droppedPriorityEvents !== undefined) {
      asyncQueueDroppedCounter.add(evt.droppedPriorityEvents, {
        "afora.diagnostic.async_queue.drop_class": "priority",
      });
    }
  };

  const recordRunCompleted = (
    evt: Extract<DiagnosticEventPayload, { type: "run.completed" }>,
    metadata: DiagnosticEventMetadata,
    privateData: DiagnosticEventPrivateData,
  ) => {
    const attrs: Record<string, string | number> = {
      "afora.outcome": evt.outcome,
      "afora.provider": evt.provider ?? "unknown",
      "afora.model": evt.model ?? "unknown",
    };
    if (evt.channel) {
      attrs["afora.channel"] = evt.channel;
    }
    if (evt.blockedBy) {
      attrs["afora.blocked_by"] = normalizeDiagnosticValue(evt.blockedBy, "unknown");
    }
    durationHistogram.record(evt.durationMs, attrs);
    if (!tracesEnabled) {
      return;
    }
    const spanAttrs: Record<string, string | number | boolean> = {
      "afora.outcome": evt.outcome,
    };
    addRunAttrs(spanAttrs, evt);
    if (evt.blockedBy) {
      spanAttrs["afora.blocked_by"] = normalizeDiagnosticValue(evt.blockedBy, "unknown");
    }
    if (evt.errorCategory) {
      spanAttrs["afora.errorCategory"] = normalizeDiagnosticValue(evt.errorCategory, "other");
    }
    // Redacted message goes on the span only, never the low-cardinality metric attrs.
    const redactedError = normalizeOtelErrorMessage(privateData.errorMessage);
    if (redactedError) {
      spanAttrs["afora.error"] = redactedError;
    }
    const trustedTrace = trustedTraceContext(evt, metadata);
    const trackedSpan = trustedTrace?.spanId
      ? activeTrustedSpans.get(trustedTrace.spanId)
      : undefined;
    const span =
      trackedSpan ??
      spanWithDuration("afora.run", spanAttrs, evt.durationMs, {
        parentContext: activeTrustedParentContext(evt, metadata),
        endTimeMs: evt.ts,
      });
    setSpanAttrs(span, spanAttrs);
    if (evt.outcome === "error") {
      const message =
        redactedError ?? (evt.errorCategory ? redactSensitiveText(evt.errorCategory) : undefined);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        ...(message ? { message } : {}),
      });
    }
    if (trackedSpan && trustedTrace?.spanId) {
      completeTrackedLifecycleSpan(trustedTrace, trackedSpan, evt.ts);
      return;
    }
    span.end(evt.ts);
  };

  return {
    recordLaneEnqueue,
    recordLaneDequeue,
    recordSessionState,
    recordSessionTurnCreated,
    recordSessionStuck,
    recordSessionRecoveryRequested,
    recordSessionRecoveryCompleted,
    recordTalkEvent,
    recordRunAttempt,
    recordToolLoop,
    recordMemoryUsageMetrics,
    recordMemorySample,
    recordMemoryPressure,
    recordAsyncQueueDropped,
    recordRunCompleted,
  };
}
