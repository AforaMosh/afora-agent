import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setEmbeddedMode } from "../infra/embedded-mode.js";
import {
  EmbeddedPluginApprovalBroker,
  setEmbeddedPluginApprovalBroker,
} from "../infra/embedded-plugin-approval-broker.js";
import { getGlobalHookRunner, resetGlobalHookRunner } from "../plugins/hook-runner-global.js";
import type { HookRunner } from "../plugins/hooks.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { PluginApprovalResolutions } from "../plugins/types.js";
import { runBeforeToolCallHook } from "./agent-tools.before-tool-call.js";
import { callGatewayTool } from "./tools/gateway.js";

vi.mock("../plugins/hook-runner-global.js", async () => {
  const actual = await vi.importActual<typeof import("../plugins/hook-runner-global.js")>(
    "../plugins/hook-runner-global.js",
  );
  return { ...actual, getGlobalHookRunner: vi.fn() };
});
vi.mock("./tools/gateway.js", () => ({ callGatewayTool: vi.fn() }));

const mockGetGlobalHookRunner = vi.mocked(getGlobalHookRunner);
const mockCallGatewayTool = vi.mocked(callGatewayTool);

describe("configured MCP trusted policy ordering", () => {
  let hookRunner: Pick<HookRunner, "hasHooks" | "runBeforeToolCall">;
  let runBeforeToolCallMock: ReturnType<typeof vi.fn<HookRunner["runBeforeToolCall"]>>;

  beforeEach(() => {
    resetGlobalHookRunner();
    runBeforeToolCallMock = vi.fn<HookRunner["runBeforeToolCall"]>();
    hookRunner = {
      hasHooks: vi.fn<HookRunner["hasHooks"]>().mockReturnValue(true),
      runBeforeToolCall: runBeforeToolCallMock,
    };
    mockGetGlobalHookRunner.mockReturnValue(hookRunner as HookRunner);
    mockCallGatewayTool.mockReset();
    setActivePluginRegistry(createEmptyPluginRegistry());
    setEmbeddedMode(true);
  });

  afterEach(() => {
    setEmbeddedPluginApprovalBroker(null);
    setEmbeddedMode(false);
    setActivePluginRegistry(createEmptyPluginRegistry());
    resetGlobalHookRunner();
  });

  it("lets a trusted policy veto an MCP tool before opening approval", async () => {
    const broker = new EmbeddedPluginApprovalBroker();
    setEmbeddedPluginApprovalBroker(broker);
    const registry = createEmptyPluginRegistry();
    registry.trustedToolPolicies = [
      {
        pluginId: "trusted-policy",
        pluginName: "Trusted Policy",
        source: "test",
        policy: {
          id: "block-mcp",
          description: "Block configured MCP mutations",
          evaluate: () => ({ block: true, blockReason: "owner veto" }),
        },
      },
    ];
    setActivePluginRegistry(registry);

    const result = await runBeforeToolCallHook({
      toolName: "private__mutate",
      params: {},
      toolCallId: "call-mcp-trusted-veto",
      mcp: {
        serverName: "private",
        safeServerName: "private",
        toolName: "mutate",
        operation: "tool",
        codexApproval: { mode: "prompt", annotations: {} },
      },
      ctx: {
        trigger: "user",
        approvalReviewerDeviceId: "device-reviewer",
        codexMcpApprovalPolicy: { autoApprove: false },
      },
    });

    expect(result).toMatchObject({
      blocked: true,
      deniedReason: "plugin-before-tool-call",
      reason: "owner veto",
    });
    expect(broker.listPending()).toEqual([]);
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
    expect(runBeforeToolCallMock).not.toHaveBeenCalled();
  });

  it("approves trusted-policy rewrites instead of stale MCP params", async () => {
    const broker = new EmbeddedPluginApprovalBroker();
    setEmbeddedPluginApprovalBroker(broker);
    const evaluate = vi.fn(() => ({ params: { scope: "trusted" } }));
    const registry = createEmptyPluginRegistry();
    registry.trustedToolPolicies = [
      {
        pluginId: "trusted-policy",
        pluginName: "Trusted Policy",
        source: "test",
        policy: {
          id: "rewrite-mcp",
          description: "Rewrite configured MCP params",
          evaluate,
        },
      },
    ];
    setActivePluginRegistry(registry);
    runBeforeToolCallMock.mockResolvedValue({});

    const resultPromise = runBeforeToolCallHook({
      toolName: "private__mutate",
      params: { scope: "requested" },
      toolCallId: "call-mcp-trusted-rewrite",
      mcp: {
        serverName: "private",
        safeServerName: "private",
        toolName: "mutate",
        operation: "tool",
        codexApproval: { mode: "prompt", annotations: {} },
      },
      ctx: {
        trigger: "user",
        approvalReviewerDeviceId: "device-reviewer",
        codexMcpApprovalPolicy: { autoApprove: false },
      },
    });
    await vi.waitFor(() => expect(broker.listPending()).toHaveLength(1));
    expect(evaluate).toHaveBeenCalledOnce();
    const pending = expectDefined(
      broker.listPending()[0],
      "trusted rewrite MCP approval test invariant",
    );
    expect(broker.resolve(pending.id, "allow-once")).toBe(true);

    await expect(resultPromise).resolves.toMatchObject({
      blocked: false,
      params: { scope: "trusted" },
    });
    expect(runBeforeToolCallMock).toHaveBeenCalledWith(
      expect.objectContaining({ params: { scope: "trusted" } }),
      expect.anything(),
    );
  });

  it("carries trusted rewrites through both trusted and MCP approval gates", async () => {
    const broker = new EmbeddedPluginApprovalBroker();
    setEmbeddedPluginApprovalBroker(broker);
    const registry = createEmptyPluginRegistry();
    registry.trustedToolPolicies = [
      {
        pluginId: "trusted-policy",
        pluginName: "Trusted Policy",
        source: "test",
        policy: {
          id: "approve-mcp",
          description: "Approve configured MCP mutation",
          evaluate: () => ({
            params: { scope: "trusted" },
            requireApproval: {
              pluginId: "trusted-policy",
              title: "Trusted policy approval",
              description: "Approve the trusted policy first",
            },
          }),
        },
      },
    ];
    setActivePluginRegistry(registry);
    (hookRunner.hasHooks as ReturnType<typeof vi.fn>).mockReturnValue(false);

    const resultPromise = runBeforeToolCallHook({
      toolName: "private__mutate",
      params: { scope: "requested" },
      toolCallId: "call-mcp-dual-approval",
      mcp: {
        serverName: "private",
        safeServerName: "private",
        toolName: "mutate",
        operation: "tool",
        codexApproval: { mode: "prompt", annotations: {} },
      },
      ctx: {
        trigger: "user",
        approvalReviewerDeviceId: "device-reviewer",
        codexMcpApprovalPolicy: { autoApprove: false },
      },
    });
    await vi.waitFor(() => expect(broker.listPending()).toHaveLength(1));
    const trusted = expectDefined(
      broker.listPending()[0],
      "trusted policy approval ordering invariant",
    );
    expect(trusted.request.pluginId).toBe("trusted-policy");
    expect(broker.resolve(trusted.id, "allow-once")).toBe(true);
    await vi.waitFor(() => expect(broker.listPending()).toHaveLength(1));
    const mcp = expectDefined(broker.listPending()[0], "MCP approval ordering invariant");
    expect(mcp.request.pluginId).toBe("bundle-mcp");
    expect(broker.resolve(mcp.id, "allow-once")).toBe(true);

    await expect(resultPromise).resolves.toMatchObject({
      blocked: false,
      params: { scope: "trusted" },
      approvalResolution: PluginApprovalResolutions.ALLOW_ONCE,
    });
  });
});
