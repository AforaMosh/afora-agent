/**
 * Static identity for names that select core agent factory families before assembly.
 */

import { AUTOMATIONS_TOOL_NAME } from "./tools/automations-tool-name.js";

export type CoreToolFactoryFamily = "base-coding" | "shell" | "afora";

type CoreToolFactoryDescriptor = {
  name: string;
  family: CoreToolFactoryFamily;
};

const CORE_TOOL_FACTORY_DESCRIPTORS = [
  { name: "edit", family: "base-coding" },
  { name: "read", family: "base-coding" },
  { name: "write", family: "base-coding" },
  { name: "apply_patch", family: "shell" },
  { name: "exec", family: "shell" },
  { name: "process", family: "shell" },
  { name: "agents_list", family: "afora" },
  // Static factory identity only; runtime and tools.catalog apply the Swarm config gate.
  { name: "agents_wait", family: "afora" },
  { name: "ask_user", family: "afora" },
  { name: "afora", family: "afora" },
  { name: "computer", family: "afora" },
  { name: "conversations_list", family: "afora" },
  { name: "conversations_send", family: "afora" },
  { name: "conversations_turn", family: "afora" },
  { name: AUTOMATIONS_TOOL_NAME, family: "afora" },
  { name: "dashboard", family: "afora" },
  { name: "gateway", family: "afora" },
  { name: "get_goal", family: "afora" },
  { name: "heartbeat_respond", family: "afora" },
  { name: "view_image", family: "afora" },
  { name: "image_generate", family: "afora" },
  { name: "message", family: "afora" },
  { name: "mobile_ui", family: "afora" },
  { name: "music_generate", family: "afora" },
  { name: "nodes", family: "afora" },
  { name: "pdf", family: "afora" },
  { name: "session_status", family: "afora" },
  { name: "show_widget", family: "afora" },
  { name: "progress_card", family: "afora" },
  { name: "sessions", family: "afora" },
  { name: "sessions_history", family: "afora" },
  { name: "sessions_list", family: "afora" },
  { name: "sessions_search", family: "afora" },
  { name: "sessions_send", family: "afora" },
  { name: "sessions_spawn", family: "afora" },
  { name: "sessions_yield", family: "afora" },
  { name: "structured_output", family: "afora" },
  { name: "skill_workshop", family: "afora" },
  { name: "suggest_task", family: "afora" },
  { name: "create_goal", family: "afora" },
  { name: "subagents", family: "afora" },
  { name: "terminal", family: "afora" },
  { name: "portal", family: "afora" },
  { name: "transcripts", family: "afora" },
  { name: "tts", family: "afora" },
  { name: "update_goal", family: "afora" },
  { name: "dismiss_task", family: "afora" },
  { name: "video_generate", family: "afora" },
  { name: "web_fetch", family: "afora" },
  { name: "web_search", family: "afora" },
] as const satisfies readonly CoreToolFactoryDescriptor[];

const CORE_TOOL_FACTORY_FAMILY_BY_NAME = new Map<string, CoreToolFactoryFamily>(
  CORE_TOOL_FACTORY_DESCRIPTORS.map(({ name, family }) => [name, family]),
);

export type AforaCodingToolConstructionPlan = {
  includeBaseCodingTools: boolean;
  includeShellTools: boolean;
  includeChannelTools: boolean;
  includeAforaTools: boolean;
  includePluginTools: boolean;
};

export function resolveCoreToolFactoryFamily(name: string): CoreToolFactoryFamily | undefined {
  return CORE_TOOL_FACTORY_FAMILY_BY_NAME.get(name);
}

/**
 * Core coding primitives (file + shell families). Tool-search compaction keeps
 * these directly visible: hiding them behind search adds a lookup round-trip to
 * nearly every coding turn.
 */
export function isCoreCodingSurfaceToolName(name: string): boolean {
  const family = CORE_TOOL_FACTORY_FAMILY_BY_NAME.get(name);
  return family === "base-coding" || family === "shell";
}
