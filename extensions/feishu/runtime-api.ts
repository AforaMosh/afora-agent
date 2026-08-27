// Private runtime barrel for the bundled Feishu extension.
// Keep this barrel thin and generic-only.

export type {
  AllowlistMatch,
  AnyAgentTool,
  BaseProbeResult,
  ChannelGroupContext,
  ChannelMessageActionName,
  ChannelMeta,
  ChannelOutboundAdapter,
  ChannelPlugin,
  HistoryEntry,
  AforaConfig,
  AforaPluginApi,
  OutboundIdentity,
  PluginRuntime,
  ReplyPayload,
} from "afora-agent/plugin-sdk/core";
export type { AforaConfig as ClawdbotConfig } from "afora-agent/plugin-sdk/core";
export type RuntimeEnv = {
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  exit: (code: number) => void;
};
export type { GroupToolPolicyConfig } from "afora-agent/plugin-sdk/config-contracts";
export {
  DEFAULT_ACCOUNT_ID,
  buildChannelConfigSchema,
  createActionGate,
  createDedupeCache,
} from "afora-agent/plugin-sdk/core";
export {
  PAIRING_APPROVED_MESSAGE,
  buildProbeChannelStatusSummary,
  createDefaultChannelRuntimeState,
} from "afora-agent/plugin-sdk/channel-status";
export { createChannelPairingController } from "afora-agent/plugin-sdk/channel-pairing";
export { createReplyPrefixContext } from "afora-agent/plugin-sdk/channel-outbound";
export {
  evaluateSupplementalContextVisibility,
  filterSupplementalContextItems,
  resolveChannelContextVisibilityMode,
} from "afora-agent/plugin-sdk/context-visibility-runtime";
export { getSessionEntry } from "afora-agent/plugin-sdk/session-store-runtime";
export { readJsonFileWithFallback } from "afora-agent/plugin-sdk/json-store";
export { normalizeAgentId } from "afora-agent/plugin-sdk/routing";
export { chunkTextForOutbound } from "afora-agent/plugin-sdk/text-chunking";
export {
  isRequestBodyLimitError,
  readRequestBodyWithLimit,
  requestBodyErrorToText,
} from "afora-agent/plugin-sdk/webhook-ingress";
export { setFeishuRuntime } from "./src/runtime.js";
