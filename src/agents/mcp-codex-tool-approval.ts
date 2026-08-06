import type { McpCodexToolApprovalMode } from "../config/types.mcp.js";

export type McpToolApprovalAnnotations = {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
};

const APPROVAL_MODES = new Set<McpCodexToolApprovalMode>(["auto", "prompt", "writes", "approve"]);

export function normalizeCodexMcpToolApprovalMode(
  value: unknown,
): McpCodexToolApprovalMode | undefined {
  return typeof value === "string" && APPROVAL_MODES.has(value as McpCodexToolApprovalMode)
    ? (value as McpCodexToolApprovalMode)
    : undefined;
}

export function resolveEffectiveCodexMcpToolApprovalMode(
  name: string,
  server: { codex?: unknown; url?: unknown },
): McpCodexToolApprovalMode {
  const codex =
    server.codex && typeof server.codex === "object" && !Array.isArray(server.codex)
      ? (server.codex as Record<string, unknown>)
      : {};
  const configured =
    normalizeCodexMcpToolApprovalMode(codex.defaultToolsApprovalMode) ??
    normalizeCodexMcpToolApprovalMode(codex.default_tools_approval_mode);
  if (configured) {
    return configured;
  }
  // Preserve the shipped native projection exception for OpenClaw's loopback MCP.
  return name === "openclaw" &&
    typeof server.url === "string" &&
    /^https?:\/\/(?:127\.0\.0\.1|localhost):\d+\/mcp(?:[?#].*)?$/.test(server.url)
    ? "approve"
    : "auto";
}

export function normalizeMcpToolApprovalAnnotations(value: unknown): McpToolApprovalAnnotations {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const annotations = value as Record<string, unknown>;
  const normalized: McpToolApprovalAnnotations = {};
  for (const key of [
    "readOnlyHint",
    "destructiveHint",
    "idempotentHint",
    "openWorldHint",
  ] as const) {
    if (typeof annotations[key] === "boolean") {
      normalized[key] = annotations[key];
    }
  }
  return normalized;
}

/** Mirrors Codex's native MCP approval table for OpenClaw-projected tools. */
export function requiresCodexMcpToolApproval(params: {
  mode: McpCodexToolApprovalMode;
  annotations: McpToolApprovalAnnotations;
}): boolean {
  if (params.mode === "approve") {
    return false;
  }
  if (params.mode === "prompt") {
    return true;
  }
  if (params.mode === "writes") {
    return params.annotations.readOnlyHint !== true;
  }
  if (params.annotations.destructiveHint === true) {
    return true;
  }
  if (params.annotations.readOnlyHint === true) {
    return false;
  }
  return params.annotations.destructiveHint !== false || params.annotations.openWorldHint !== false;
}
