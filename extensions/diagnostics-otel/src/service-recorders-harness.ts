import { SpanStatusCode } from "@opentelemetry/api";
import {
  normalizeDiagnosticValue,
  normalizeDiagnosticLane,
} from "afora-agent/plugin-sdk/diagnostic-runtime";
import type {
  DiagnosticEventMetadata,
  DiagnosticEventPayload,
  DiagnosticEventPrivateData,
} from "../api.js";
import { normalizeOtelErrorMessage } from "./service-content-normalization.js";
import type { DiagnosticsRecorderRuntime } from "./service-recorder-runtime.js";
import type { HarnessRunDiagnosticEvent, ModelFailoverDiagnosticEvent } from "./service-types.js";

export function createHarnessRecorders(runtime: DiagnosticsRecorderRuntime) {
  const {
    harnessDurationHistogram,
    modelFailoverCounter,
    activeTrustedSpans,
    spanWithDuration,
    trustedTraceContext,
    activeTrustedParentContext,
    trackTrustedSpan,
    setSpanAttrs,
    completeTrackedLifecycleSpan,
    addRunAttrs,
    tracesEnabled,
  } = runtime;

  const harnessRunMetricAttrs = (evt: HarnessRunDiagnosticEvent) => ({
    "afora.harness.id": normalizeDiagnosticValue(evt.harnessId, "unknown"),
    "afora.harness.plugin": normalizeDiagnosticValue(evt.pluginId),
    ...(evt.type === "harness.run.started"
      ? {}
      : {
          "afora.outcome": evt.type === "harness.run.error" ? "error" : evt.outcome,
        }),
    "afora.provider": normalizeDiagnosticValue(evt.provider, "unknown"),
    "afora.model": normalizeDiagnosticValue(evt.model, "unknown"),
    ...(evt.channel ? { "afora.channel": normalizeDiagnosticValue(evt.channel) } : {}),
  });

  const recordHarnessRunStarted = (
    evt: Extract<DiagnosticEventPayload, { type: "harness.run.started" }>,
    metadata: DiagnosticEventMetadata,
  ) => {
    if (!tracesEnabled || !metadata.trusted) {
      return;
    }
    trackTrustedSpan(
      evt,
      metadata,
      spanWithDuration("afora.harness.run", harnessRunMetricAttrs(evt), undefined, {
        parentContext: activeTrustedParentContext(evt, metadata),
        startTimeMs: evt.ts,
      }),
    );
  };

  const recordHarnessRunCompleted = (
    evt: Extract<DiagnosticEventPayload, { type: "harness.run.completed" }>,
    metadata: DiagnosticEventMetadata,
    privateData: DiagnosticEventPrivateData,
  ) => {
    harnessDurationHistogram.record(evt.durationMs, harnessRunMetricAttrs(evt));
    if (!tracesEnabled) {
      return;
    }
    const spanAttrs: Record<string, string | number | boolean> = {
      ...harnessRunMetricAttrs(evt),
    };
    if (evt.resultClassification) {
      spanAttrs["afora.harness.result_classification"] = normalizeDiagnosticValue(
        evt.resultClassification,
      );
    }
    if (typeof evt.yieldDetected === "boolean") {
      spanAttrs["afora.harness.yield_detected"] = evt.yieldDetected;
    }
    if (evt.itemLifecycle) {
      spanAttrs["afora.harness.items.started"] = evt.itemLifecycle.startedCount;
      spanAttrs["afora.harness.items.completed"] = evt.itemLifecycle.completedCount;
      spanAttrs["afora.harness.items.active"] = evt.itemLifecycle.activeCount;
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
      spanWithDuration("afora.harness.run", spanAttrs, evt.durationMs, {
        parentContext: activeTrustedParentContext(evt, metadata),
        endTimeMs: evt.ts,
      });
    setSpanAttrs(span, spanAttrs);
    if (evt.outcome === "error") {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: redactedError ?? "error",
      });
    }
    if (trackedSpan && trustedTrace?.spanId) {
      completeTrackedLifecycleSpan(trustedTrace, trackedSpan, evt.ts);
      return;
    }
    span.end(evt.ts);
  };

  const recordHarnessRunError = (
    evt: Extract<DiagnosticEventPayload, { type: "harness.run.error" }>,
    metadata: DiagnosticEventMetadata,
    privateData: DiagnosticEventPrivateData,
  ) => {
    const errorType = normalizeDiagnosticValue(evt.errorCategory, "other");
    const attrs = {
      ...harnessRunMetricAttrs(evt),
      "afora.harness.phase": evt.phase,
      "afora.errorCategory": errorType,
    };
    harnessDurationHistogram.record(evt.durationMs, attrs);
    if (!tracesEnabled) {
      return;
    }
    // Redacted message goes on the span only; attrs above feed the metric.
    const redactedError = normalizeOtelErrorMessage(privateData.errorMessage);
    const spanAttrs: Record<string, string | number | boolean> = {
      ...attrs,
      "error.type": errorType,
      ...(redactedError ? { "afora.error": redactedError } : {}),
      ...(evt.cleanupFailed ? { "afora.harness.cleanup_failed": true } : {}),
    };
    const trustedTrace = trustedTraceContext(evt, metadata);
    const trackedSpan = trustedTrace?.spanId
      ? activeTrustedSpans.get(trustedTrace.spanId)
      : undefined;
    const span =
      trackedSpan ??
      spanWithDuration("afora.harness.run", spanAttrs, evt.durationMs, {
        parentContext: activeTrustedParentContext(evt, metadata),
        endTimeMs: evt.ts,
      });
    setSpanAttrs(span, spanAttrs);
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: redactedError ?? errorType,
    });
    // Retain on the error path too: for the afora harness this span is the only
    // ancestor a late child can attach to, and aborted turns emit no run.completed.
    if (trackedSpan && trustedTrace?.spanId) {
      completeTrackedLifecycleSpan(trustedTrace, trackedSpan, evt.ts);
      return;
    }
    span.end(evt.ts);
  };

  const recordContextAssembled = (
    evt: Extract<DiagnosticEventPayload, { type: "context.assembled" }>,
    metadata: DiagnosticEventMetadata,
  ) => {
    if (!tracesEnabled) {
      return;
    }
    const spanAttrs: Record<string, string | number | boolean> = {
      "afora.context.message_count": evt.messageCount,
      "afora.context.history_text_chars": evt.historyTextChars,
      "afora.context.history_image_blocks": evt.historyImageBlocks,
      "afora.context.max_message_text_chars": evt.maxMessageTextChars,
      "afora.context.system_prompt_chars": evt.systemPromptChars,
      "afora.context.prompt_chars": evt.promptChars,
      "afora.context.prompt_images": evt.promptImages,
    };
    addRunAttrs(spanAttrs, evt);
    if (evt.contextTokenBudget !== undefined) {
      spanAttrs["afora.context.token_budget"] = evt.contextTokenBudget;
    }
    if (evt.reserveTokens !== undefined) {
      spanAttrs["afora.context.reserve_tokens"] = evt.reserveTokens;
    }
    const span = spanWithDuration("afora.context.assembled", spanAttrs, 0, {
      parentContext: activeTrustedParentContext(evt, metadata),
      endTimeMs: evt.ts,
    });
    span.end(evt.ts);
  };

  const recordModelFailover = (
    evt: ModelFailoverDiagnosticEvent,
    metadata: DiagnosticEventMetadata,
  ) => {
    const metricAttrs: Record<string, string> = {
      "afora.failover.reason": normalizeDiagnosticValue(evt.reason, "unknown"),
      "afora.failover.suspended":
        evt.suspended === undefined ? "unknown" : String(evt.suspended),
      "afora.lane": normalizeDiagnosticLane(evt.lane, "unknown"),
      "afora.model": normalizeDiagnosticValue(evt.fromModel),
      "afora.provider": normalizeDiagnosticValue(evt.fromProvider),
      "afora.failover.to_model": normalizeDiagnosticValue(evt.toModel),
      "afora.failover.to_provider": normalizeDiagnosticValue(evt.toProvider),
    };
    modelFailoverCounter.add(1, metricAttrs);
    if (!tracesEnabled) {
      return;
    }
    const spanAttrs: Record<string, string | number | boolean> = {
      "afora.failover.reason": normalizeDiagnosticValue(evt.reason, "unknown"),
    };
    if (evt.fromProvider) {
      spanAttrs["afora.provider"] = evt.fromProvider;
    }
    if (evt.fromModel) {
      spanAttrs["afora.model"] = evt.fromModel;
    }
    if (evt.toProvider) {
      spanAttrs["afora.failover.to_provider"] = evt.toProvider;
    }
    if (evt.toModel) {
      spanAttrs["afora.failover.to_model"] = evt.toModel;
    }
    if (evt.lane) {
      spanAttrs["afora.lane"] = normalizeDiagnosticLane(evt.lane, "unknown");
    }
    if (evt.suspended !== undefined) {
      spanAttrs["afora.failover.suspended"] = evt.suspended;
    }
    if (evt.cascadeDepth !== undefined) {
      spanAttrs["afora.failover.cascade_depth"] = evt.cascadeDepth;
    }
    const span = spanWithDuration("afora.model.failover", spanAttrs, 0, {
      parentContext: activeTrustedParentContext(evt, metadata),
      endTimeMs: evt.ts,
    });
    span.end(evt.ts);
  };

  return {
    recordHarnessRunStarted,
    recordHarnessRunCompleted,
    recordHarnessRunError,
    recordContextAssembled,
    recordModelFailover,
  };
}
