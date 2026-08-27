import type {
  AforaPluginApi,
  AforaPluginNodeInvokePolicy,
} from "afora-agent/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";
import plugin from "./index.js";

type PolicyContext = Parameters<AforaPluginNodeInvokePolicy["handle"]>[0];

function registerLogbookPolicies(): AforaPluginNodeInvokePolicy[] {
  const policies: AforaPluginNodeInvokePolicy[] = [];
  plugin.register({
    pluginConfig: {},
    session: { controls: { registerControlUiDescriptor: () => {} } },
    registerNodeInvokePolicy: (policy: AforaPluginNodeInvokePolicy) => policies.push(policy),
    registerService: () => {},
    registerGatewayMethod: () => {},
  } as unknown as AforaPluginApi);
  return policies;
}

describe("logbook snapshot invoke policy", () => {
  it("blocks logbook.snapshot when gateway.nodes.commands.deny lists screen.snapshot", async () => {
    const [policy] = registerLogbookPolicies();
    expect(policy?.commands).toEqual(["logbook.snapshot"]);
    const invokeNode = vi.fn();
    const result = await policy!.handle({
      nodeId: "node-1",
      command: "logbook.snapshot",
      params: undefined,
      config: { gateway: { nodes: { commands: { deny: ["screen.snapshot"] } } } },
      invokeNode,
    } as unknown as PolicyContext);
    expect(result).toMatchObject({ ok: false, code: "SCREEN_CAPTURE_DENIED" });
    expect(invokeNode).not.toHaveBeenCalled();
  });

  it("invokes the node when screen.snapshot is not denied", async () => {
    const [policy] = registerLogbookPolicies();
    const invokeNode = vi.fn().mockResolvedValue({ ok: true, payloadJSON: null });
    const result = await policy!.handle({
      nodeId: "node-1",
      command: "logbook.snapshot",
      params: undefined,
      config: { gateway: { nodes: { commands: { deny: ["camera.snap"] } } } },
      invokeNode,
    } as unknown as PolicyContext);
    expect(result).toMatchObject({ ok: true });
    expect(invokeNode).toHaveBeenCalledTimes(1);
  });
});
