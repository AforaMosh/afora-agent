// Diagnostics Otel API module exposes the plugin public contract.
export {
  createChildDiagnosticTraceContext,
  createDiagnosticTraceContext,
  emitDiagnosticEvent,
  formatDiagnosticTraceparent,
  isValidDiagnosticSpanId,
  isValidDiagnosticTraceFlags,
  isValidDiagnosticTraceId,
  onDiagnosticEvent,
  parseDiagnosticTraceparent,
  type DiagnosticEventMetadata,
  type DiagnosticEventPayload,
  type DiagnosticEventPrivateData,
  type DiagnosticTraceContext,
} from "afora-agent/plugin-sdk/diagnostic-runtime";
export { emptyPluginConfigSchema, type AforaPluginApi } from "afora-agent/plugin-sdk/plugin-entry";
export type {
  AforaPluginService,
  AforaPluginServiceContext,
} from "afora-agent/plugin-sdk/plugin-entry";
export { redactSensitiveText } from "afora-agent/plugin-sdk/security-runtime";
