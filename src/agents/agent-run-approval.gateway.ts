import type { AgentRunApprovalHost } from "./agent-run-approval.js";
import { noAgentRunApprovalHost } from "./agent-run-approval.js";

/**
 * Gateway approval capabilities are added by the plugin and exec migration
 * layers. Until then, callers must carry explicit absence without falling
 * back to ambient process state.
 */
export function createGatewayAgentRunApprovalHost(_options?: {
  approvalReviewerDeviceIds?: readonly string[];
  runtimeInstanceId?: string;
}): AgentRunApprovalHost {
  return Object.freeze({ mode: "none" });
}

export const gatewayAgentRunApprovalHost = createGatewayAgentRunApprovalHost();

/** Resolves the exact approval owner selected by one Gateway agent request. */
export function resolveGatewayAgentRunApprovalHost(params: {
  approvalHostMode?: "none";
  inheritedApprovalHost?: AgentRunApprovalHost;
  approvalReviewerDeviceId?: string;
}): AgentRunApprovalHost {
  if (params.approvalHostMode === "none") {
    return noAgentRunApprovalHost;
  }
  if (params.inheritedApprovalHost) {
    return params.inheritedApprovalHost;
  }
  return params.approvalReviewerDeviceId?.trim()
    ? createGatewayAgentRunApprovalHost()
    : gatewayAgentRunApprovalHost;
}
