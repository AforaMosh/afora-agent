/**
 * Public runtime API barrel for ACPX. Core and plugin consumers import these
 * SDK-facing ACP runtime contracts instead of reaching into ACPX internals.
 */
export type { AcpRuntimeErrorCode } from "afora-agent/plugin-sdk/acp-runtime-backend";
export {
  AcpRuntimeError,
  getAcpRuntimeBackend,
  tryDispatchAcpReplyHook,
  registerAcpRuntimeBackend,
  unregisterAcpRuntimeBackend,
} from "afora-agent/plugin-sdk/acp-runtime-backend";
export type {
  AcpRuntime,
  AcpRuntimeCapabilities,
  AcpRuntimeDoctorReport,
  AcpRuntimeEnsureInput,
  AcpRuntimeEvent,
  AcpRuntimeHandle,
  AcpRuntimeStatus,
  AcpRuntimeTurn,
  AcpRuntimeTurnAttachment,
  AcpRuntimeTurnInput,
  AcpRuntimeTurnResult,
  AcpRuntimeTurnResultError,
  AcpSessionUpdateTag,
} from "afora-agent/plugin-sdk/acp-runtime-backend";
export type {
  AforaPluginApi,
  AforaPluginConfigSchema,
  AforaPluginService,
  AforaPluginServiceContext,
  PluginLogger,
} from "afora-agent/plugin-sdk/core";
export type {
  PluginHookReplyDispatchContext,
  PluginHookReplyDispatchEvent,
  PluginHookReplyDispatchResult,
} from "afora-agent/plugin-sdk/core";
export type {
  WindowsSpawnProgram,
  WindowsSpawnProgramCandidate,
  WindowsSpawnResolution,
} from "afora-agent/plugin-sdk/windows-spawn";
export {
  applyWindowsSpawnProgramPolicy,
  materializeWindowsSpawnProgram,
  resolveWindowsSpawnProgramCandidate,
} from "afora-agent/plugin-sdk/windows-spawn";
export {
  listKnownProviderAuthEnvVarNames,
  omitEnvKeysCaseInsensitive,
} from "afora-agent/plugin-sdk/provider-env-vars";
