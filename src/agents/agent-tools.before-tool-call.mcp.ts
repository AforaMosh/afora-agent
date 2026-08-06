import type { PluginToolMcpMeta } from "../plugins/tools.js";
import type { PluginHookBeforeToolCallResult } from "../plugins/types.js";
import type { HookContext, HookOutcome } from "./agent-tools.before-tool-call.types.js";
import { requiresCodexMcpToolApproval } from "./mcp-codex-tool-approval.js";

function describeMcpTool(mcp: PluginToolMcpMeta): string {
  return `${mcp.serverName}.${mcp.toolName}`;
}

export function resolveCodexMcpApprovalPolicy(params: {
  mcp?: PluginToolMcpMeta;
  ctx?: HookContext;
  toolParams: unknown;
}): PluginHookBeforeToolCallResult | Extract<HookOutcome, { blocked: true }> | undefined {
  const mcp = params.mcp;
  const policy = params.ctx?.codexMcpApprovalPolicy;
  if (!mcp?.codexApproval || mcp.operation !== "tool" || !policy || policy.autoApprove) {
    return undefined;
  }
  if (!requiresCodexMcpToolApproval(mcp.codexApproval)) {
    return undefined;
  }

  const displayName = describeMcpTool(mcp);
  const trigger = params.ctx?.trigger?.trim();
  if (trigger && trigger !== "user") {
    return {
      blocked: true,
      kind: "failure",
      disposition: "failed",
      deniedReason: "mcp-approval-unavailable",
      reason: `MCP tool "${displayName}" requires interactive approval, but ${trigger} runs cannot prompt. Set mcp.servers.${mcp.serverName}.codex.defaultToolsApprovalMode to "approve" only if unattended execution is intended.`,
      params: params.toolParams,
    };
  }
  if (
    trigger === "user" &&
    !params.ctx?.turnSourceChannel &&
    !params.ctx?.approvalReviewerDeviceId
  ) {
    return {
      blocked: true,
      kind: "failure",
      disposition: "failed",
      deniedReason: "mcp-approval-unavailable",
      reason: `MCP tool "${displayName}" requires interactive approval, but this CLI run has no approval-capable reviewer. Run it from an interactive approval surface or set mcp.servers.${mcp.serverName}.codex.defaultToolsApprovalMode to "approve" only if automatic execution is intended.`,
      params: params.toolParams,
    };
  }

  return {
    requireApproval: {
      pluginId: "bundle-mcp",
      title: `Approve MCP tool ${displayName}`,
      description: `Allow MCP tool "${displayName}" to run once?`,
      severity: "warning",
      allowedDecisions: ["allow-once", "deny"],
      timeoutReason: `MCP tool approval timed out for "${displayName}".`,
    },
  };
}
