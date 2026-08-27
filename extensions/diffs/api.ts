// Diffs API module exposes the plugin public contract.
export type { AforaConfig } from "afora-agent/plugin-sdk/config-contracts";
export {
  definePluginEntry,
  type AnyAgentTool,
  type AforaPluginApi,
  type AforaPluginConfigSchema,
  type AforaPluginToolContext,
  type PluginLogger,
} from "afora-agent/plugin-sdk/plugin-entry";
export { resolvePreferredAforaTmpDir } from "afora-agent/plugin-sdk/temp-path";
