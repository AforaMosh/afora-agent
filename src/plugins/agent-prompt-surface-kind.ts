// Normalizes agent prompt surface kinds advertised by plugins.
import type { AgentPromptSurfaceKind } from "./types.js";

/** Normalizes legacy prompt surface names to current Afora surface names. */
export function normalizeAgentPromptSurfaceKind(
  surface: AgentPromptSurfaceKind,
): AgentPromptSurfaceKind {
  return surface === "pi_main" ? "afora_main" : surface;
}

/** True when a prompt surface targets the main Afora prompt. */
export function isAforaMainPromptSurface(surface: AgentPromptSurfaceKind): boolean {
  return normalizeAgentPromptSurfaceKind(surface) === "afora_main";
}
