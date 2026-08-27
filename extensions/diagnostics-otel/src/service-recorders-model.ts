import { SpanStatusCode } from "@opentelemetry/api";
import { normalizeDiagnosticValue } from "afora-agent/plugin-sdk/diagnostic-runtime";
import { redactSensitiveText } from "../api.js";
import type { DiagnosticEventMetadata, DiagnosticEventPayload } from "../api.js";
import {
  addUpstreamRequestIdSpanEvent,
  assignGenAiModelCallAttrs,
  assignModelCallPromptStatsAttrs,
  assignModelCallSizeTimingAttrs,
  assignModelCallUsageAttrs,
  genAiOperationName,
  modelCallSpanKind,
  modelCallSpanName,
  modelCallObservationUnit,
  positiveFiniteNumber,
} from "./service-genai-attributes.js";
import { assignOtelModelContentAttributes } from "./service-genai-content.js";
import type { OtelModelCallContent } from "./service-genai-content.js";
import type { DiagnosticsRecorderRuntime } from "./service-recorder-runtime.js";
import type { ModelCallLifecycleDiagnosticEvent } from "./service-types.js";

export function createModelRecorders(runtime: DiagnosticsRecorderRuntime) {
  const {
    genAiOperationDurationHistogram,
    modelCallDurationHistogram,
    modelCallRequestBytesHistogram,
    modelCallResponseBytesHistogram,
    modelCallTimeToFirstByteHistogram,
    spanWithDuration,
    activeTrustedParentContext,
    trackTrustedSpan,
    getTrackedInternalOrTrustedSpan,
    takeTrackedTrustedSpan,
    setSpanAttrs,
    contentCapturePolicy,
    tracesEnabled,
  } = runtime;

  const modelCallMetricAttrs = (evt: ModelCallLifecycleDiagnosticEvent) => ({
    "afora.provider": evt.provider,
    "afora.model": evt.model,
    "afora.api": normalizeDiagnosticValue(evt.api),
    "afora.transport": normalizeDiagnosticValue(evt.transport),
    "afora.model_call.observation_unit": modelCallObservationUnit(evt),
  });
  const genAiModelCallMetricAttrs = (
    evt: ModelCallLifecycleDiagnosticEvent,
    errorType?: string,
  ) => ({
    "gen_ai.operation.name": genAiOperationName(evt.api, evt.observationUnit),
    "gen_ai.provider.name": normalizeDiagnosticValue(evt.provider),
    "gen_ai.request.model": normalizeDiagnosticValue(evt.model),
    ...(errorType ? { "error.type": errorType } : {}),
  });
  const recordGenAiModelCallDuration = (
    evt: ModelCallLifecycleDiagnosticEvent,
    errorType?: string,
  ) => {
    genAiOperationDurationHistogram.record(
      evt.durationMs / 1000,
      genAiModelCallMetricAttrs(evt, errorType),
    );
  };
  const recordModelCallSizeTimingMetrics = (
    evt: Extract<DiagnosticEventPayload, { type: "model.call.completed" | "model.call.error" }>,
    attrs: ReturnType<typeof modelCallMetricAttrs>,
  ) => {
    const requestPayloadBytes = positiveFiniteNumber(evt.requestPayloadBytes);
    if (requestPayloadBytes !== undefined) {
      modelCallRequestBytesHistogram.record(requestPayloadBytes, attrs);
    }
    const responseStreamBytes = positiveFiniteNumber(evt.responseStreamBytes);
    if (responseStreamBytes !== undefined) {
      modelCallResponseBytesHistogram.record(responseStreamBytes, attrs);
    }
    const timeToFirstByteMs = positiveFiniteNumber(evt.timeToFirstByteMs);
    if (timeToFirstByteMs !== undefined) {
      modelCallTimeToFirstByteHistogram.record(timeToFirstByteMs, attrs);
    }
  };

  const recordModelCallStarted = (
    evt: Extract<DiagnosticEventPayload, { type: "model.call.started" }>,
    metadata: DiagnosticEventMetadata,
  ) => {
    if (!tracesEnabled || !metadata.trusted) {
      return undefined;
    }
    const trackedSpan = getTrackedInternalOrTrustedSpan(evt, metadata);
    if (trackedSpan) {
      return trackedSpan.spanContext();
    }
    const spanAttrs: Record<string, string | number | boolean> = {
      "afora.provider": evt.provider,
      "afora.model": evt.model,
    };
    assignGenAiModelCallAttrs(spanAttrs, evt);
    if (evt.api) {
      spanAttrs["afora.api"] = evt.api;
    }
    if (evt.transport) {
      spanAttrs["afora.transport"] = evt.transport;
    }
    assignModelCallPromptStatsAttrs(spanAttrs, evt);
    return trackTrustedSpan(
      evt,
      metadata,
      spanWithDuration(modelCallSpanName(evt), spanAttrs, undefined, {
        kind: modelCallSpanKind(),
        parentContext: activeTrustedParentContext(evt, metadata),
        startTimeMs: evt.ts,
      }),
    ).spanContext();
  };

  const recordModelCallCompleted = (
    evt: Extract<DiagnosticEventPayload, { type: "model.call.completed" }>,
    metadata: DiagnosticEventMetadata,
    modelContent?: OtelModelCallContent,
  ) => {
    const metricAttrs = modelCallMetricAttrs(evt);
    modelCallDurationHistogram.record(evt.durationMs, metricAttrs);
    recordModelCallSizeTimingMetrics(evt, metricAttrs);
    recordGenAiModelCallDuration(evt);
    if (!tracesEnabled) {
      return;
    }
    const spanAttrs: Record<string, string | number | boolean> = {
      "afora.provider": evt.provider,
      "afora.model": evt.model,
    };
    assignGenAiModelCallAttrs(spanAttrs, evt);
    if (evt.api) {
      spanAttrs["afora.api"] = evt.api;
    }
    if (evt.transport) {
      spanAttrs["afora.transport"] = evt.transport;
    }
    assignModelCallSizeTimingAttrs(spanAttrs, evt);
    assignModelCallPromptStatsAttrs(spanAttrs, evt);
    assignModelCallUsageAttrs(spanAttrs, evt);
    assignOtelModelContentAttributes(spanAttrs, modelContent, contentCapturePolicy);
    const span =
      takeTrackedTrustedSpan(evt, metadata) ??
      spanWithDuration(modelCallSpanName(evt), spanAttrs, evt.durationMs, {
        kind: modelCallSpanKind(),
        parentContext: activeTrustedParentContext(evt, metadata),
        endTimeMs: evt.ts,
      });
    setSpanAttrs(span, spanAttrs);
    addUpstreamRequestIdSpanEvent(span, evt.upstreamRequestIdHash);
    span.end(evt.ts);
  };

  const recordModelCallError = (
    evt: Extract<DiagnosticEventPayload, { type: "model.call.error" }>,
    metadata: DiagnosticEventMetadata,
    modelContent?: OtelModelCallContent,
  ) => {
    const errorType = normalizeDiagnosticValue(evt.errorCategory, "other");
    const metricAttrs = {
      ...modelCallMetricAttrs(evt),
      "afora.errorCategory": errorType,
      ...(evt.failureKind
        ? { "afora.failureKind": normalizeDiagnosticValue(evt.failureKind, "other") }
        : {}),
    };
    modelCallDurationHistogram.record(evt.durationMs, metricAttrs);
    recordModelCallSizeTimingMetrics(evt, metricAttrs);
    recordGenAiModelCallDuration(evt, errorType);
    if (!tracesEnabled) {
      return;
    }
    const spanAttrs: Record<string, string | number | boolean> = {
      "afora.provider": evt.provider,
      "afora.model": evt.model,
      "afora.errorCategory": errorType,
      "error.type": errorType,
    };
    if (evt.failureKind) {
      spanAttrs["afora.failureKind"] = normalizeDiagnosticValue(evt.failureKind, "other");
    }
    assignGenAiModelCallAttrs(spanAttrs, evt);
    if (evt.api) {
      spanAttrs["afora.api"] = evt.api;
    }
    if (evt.transport) {
      spanAttrs["afora.transport"] = evt.transport;
    }
    assignModelCallSizeTimingAttrs(spanAttrs, evt);
    assignModelCallPromptStatsAttrs(spanAttrs, evt);
    assignModelCallUsageAttrs(spanAttrs, evt);
    assignOtelModelContentAttributes(spanAttrs, modelContent, contentCapturePolicy);
    const span =
      takeTrackedTrustedSpan(evt, metadata) ??
      spanWithDuration(modelCallSpanName(evt), spanAttrs, evt.durationMs, {
        kind: modelCallSpanKind(),
        parentContext: activeTrustedParentContext(evt, metadata),
        endTimeMs: evt.ts,
      });
    setSpanAttrs(span, spanAttrs);
    addUpstreamRequestIdSpanEvent(span, evt.upstreamRequestIdHash);
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: redactSensitiveText(evt.errorCategory),
    });
    span.end(evt.ts);
  };

  return {
    recordModelCallSizeTimingMetrics,
    recordModelCallStarted,
    recordModelCallCompleted,
    recordModelCallError,
  };
}
