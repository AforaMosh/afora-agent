// Diagnostics Prometheus API module exposes the plugin public contract.
export type {
  DiagnosticEventMetadata,
  DiagnosticEventPayload,
} from "afora-agent/plugin-sdk/diagnostic-runtime";
export { isInternalDiagnosticEventMetadata } from "afora-agent/plugin-sdk/diagnostic-runtime";
export {
  emptyPluginConfigSchema,
  type AforaPluginApi,
  type AforaPluginHttpRouteHandler,
  type AforaPluginService,
  type AforaPluginServiceContext,
} from "afora-agent/plugin-sdk/plugin-entry";
export { redactSensitiveText } from "afora-agent/plugin-sdk/security-runtime";
