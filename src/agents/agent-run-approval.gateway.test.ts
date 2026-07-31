import { describe, expect, it } from "vitest";
import {
  createGatewayAgentRunApprovalHost,
  gatewayAgentRunApprovalHost,
  resolveGatewayAgentRunApprovalHost,
} from "./agent-run-approval.gateway.js";
import { noAgentRunApprovalHost, type AgentRunApprovalHost } from "./agent-run-approval.js";

describe("Gateway agent run approval host selection", () => {
  it("keeps the pre-migration Gateway host explicitly capability-free", () => {
    expect(createGatewayAgentRunApprovalHost()).toEqual(noAgentRunApprovalHost);
    expect(createGatewayAgentRunApprovalHost()).not.toBe(noAgentRunApprovalHost);
    expect(gatewayAgentRunApprovalHost).toEqual(noAgentRunApprovalHost);
  });

  it("preserves an inherited process-local host", () => {
    const inherited: AgentRunApprovalHost = {};
    expect(
      resolveGatewayAgentRunApprovalHost({
        inheritedApprovalHost: inherited,
        approvalReviewerDeviceId: "device-1",
      }),
    ).toBe(inherited);
  });

  it("keeps explicit and default absence fail closed", () => {
    expect(resolveGatewayAgentRunApprovalHost({ approvalHostMode: "none" })).toBe(
      noAgentRunApprovalHost,
    );
    const reviewerHost = resolveGatewayAgentRunApprovalHost({
      approvalReviewerDeviceId: "device-1",
    });
    expect(reviewerHost).toEqual(noAgentRunApprovalHost);
    expect(reviewerHost).not.toBe(gatewayAgentRunApprovalHost);
  });
});
