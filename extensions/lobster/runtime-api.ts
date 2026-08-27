// Lobster API module exposes the plugin public contract.
export { definePluginEntry } from "afora-agent/plugin-sdk/core";
export type {
  AnyAgentTool,
  AforaPluginApi,
  AforaPluginToolContext,
  AforaPluginToolFactory,
} from "afora-agent/plugin-sdk/core";
export {
  applyWindowsSpawnProgramPolicy,
  materializeWindowsSpawnProgram,
  resolveWindowsSpawnProgramCandidate,
} from "afora-agent/plugin-sdk/windows-spawn";
