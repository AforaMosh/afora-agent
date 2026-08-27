import type { CliBackendToolAvailability } from "../../plugins/cli-backend.types.js";
import { normalizeToolPolicyName } from "../tool-policy.js";

/** Transport prefix CLI harnesses use for loopback Afora MCP tool names. */
const AFORA_MCP_TOOL_PREFIX = "mcp__afora__";

/** Strips the loopback MCP transport prefix so observers see gateway tool names. */
export function stripAforaMcpToolPrefix(toolName: string): string {
  return toolName.startsWith(AFORA_MCP_TOOL_PREFIX)
    ? toolName.slice(AFORA_MCP_TOOL_PREFIX.length)
    : toolName;
}

/** Builds the public backend contract plus the shipped beta MCP-name projection. */
export function buildCliBackendToolAvailability(availability: {
  native: readonly string[];
  afora: readonly string[];
}): CliBackendToolAvailability {
  return {
    native: availability.native,
    afora: availability.afora,
    mcp: availability.afora.map((toolName) => `${AFORA_MCP_TOOL_PREFIX}${toolName}`),
  };
}

/** Keeps only explicit runtime caps for backend-owned exact translation. */
export function resolveCliRuntimeToolsAllow(
  toolsAllow?: string[],
  _toolsAllowIsDefault?: boolean,
): string[] | undefined {
  if (toolsAllow === undefined) {
    return undefined;
  }
  return toolsAllow.some((toolName) => normalizeToolPolicyName(toolName) === "*")
    ? undefined
    : toolsAllow;
}
