/** Lightweight attempt gate for configured MCP runtime materialization. */
import { TOOL_NAME_SEPARATOR } from "./agent-bundle-mcp-names.js";
import { normalizeToolName } from "./tool-policy-shared.js";

function canReachBundleMcpTool(normalized: string): boolean {
  return (
    normalized === "bundle-mcp" ||
    normalized === "group:plugins" ||
    normalized.includes(TOOL_NAME_SEPARATOR)
  );
}

/** Avoids opening MCP transports when an attempt cannot expose configured MCP tools. */
export function shouldCreateBundleMcpRuntimeForAttempt(params: {
  toolsEnabled: boolean;
  disableTools?: boolean;
  toolsAllow?: string[];
}): boolean {
  if (!params.toolsEnabled || params.disableTools === true) {
    return false;
  }
  if (!params.toolsAllow) {
    return true;
  }
  if (params.toolsAllow.length === 0) {
    return false;
  }
  return params.toolsAllow.some((toolName) => {
    const normalized = normalizeToolName(toolName);
    return normalized === "*" || canReachBundleMcpTool(normalized);
  });
}
