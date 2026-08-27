// Private runtime barrel for the bundled Voice Call extension.
// Keep this barrel thin and aligned with the local extension surface.

export { definePluginEntry } from "afora-agent/plugin-sdk/plugin-entry";
export type { AforaPluginApi } from "afora-agent/plugin-sdk/plugin-entry";
export type { GatewayRequestHandlerOptions } from "afora-agent/plugin-sdk/gateway-runtime";
export {
  isRequestBodyLimitError,
  readRequestBodyWithLimit,
  requestBodyErrorToText,
} from "afora-agent/plugin-sdk/webhook-request-guards";
export { fetchWithSsrFGuard, isBlockedHostnameOrIp } from "afora-agent/plugin-sdk/ssrf-runtime";
export type { SessionEntry } from "afora-agent/plugin-sdk/session-store-runtime";
export {
  TtsAutoSchema,
  TtsConfigSchema,
  TtsModeSchema,
  TtsProviderSchema,
} from "afora-agent/plugin-sdk/tts-runtime";
export { sleep } from "afora-agent/plugin-sdk/runtime-env";
