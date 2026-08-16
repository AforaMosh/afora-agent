import "./prepared-model-runtime.test-harness.js";
import { beforeEach, describe, expect, it } from "vitest";
import { getPluginRuntimeGenerationRegistry } from "../plugins/runtime/generation-scope.js";
import {
  acquireAgentRunPreparedModelRuntime,
  getPreparedModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
} from "./prepared-model-runtime.js";
import {
  getPreparedModelRuntimeMocks,
  resetPreparedModelRuntimeHarness,
} from "./prepared-model-runtime.test-harness.js";

const mocks = getPreparedModelRuntimeMocks();

describe("prepared model runtime plugin generation", () => {
  beforeEach(() => {
    resetPreparedModelRuntimeHarness();
  });

  it("reuses the configured generation for a plugin-free dynamic workspace", async () => {
    mocks.configuredAgentIds = ["default"];
    const config = {};
    const workspaceDir = "/tmp/dynamic-plugin-free-workspace";
    const catalogGenerationRegistries: unknown[] = [];
    const dynamicPreparationRegistries: unknown[] = [];
    mocks.buildPreparedModelCatalogSnapshot.mockImplementation(async () => {
      catalogGenerationRegistries.push(getPluginRuntimeGenerationRegistry());
      return { entries: [], routeVariants: [] };
    });
    mocks.resolveAmbientCredentials.mockImplementation((...args: unknown[]) => {
      const params = args[0] as { workspaceDir?: string };
      if (params.workspaceDir === workspaceDir) {
        dynamicPreparationRegistries.push(getPluginRuntimeGenerationRegistry());
      }
      return {};
    });

    await refreshPreparedModelRuntimeSnapshots(config, {
      gatewayLifecycle: true,
      defaultWorkspaceDir: "/tmp/gateway-launch-workspace",
    });
    const configuredPluginRegistryLoads =
      mocks.loadAgentRuntimePluginRegistryHandle.mock.calls.length;
    const configuredRegistry = getPreparedModelRuntimeSnapshot({
      agentId: "default",
      config,
      agentDir: "/tmp/unused-agent",
      inheritedAuthDir: "/tmp/unused-agent",
    })?.pluginRegistry;

    const lease = await acquireAgentRunPreparedModelRuntime({
      agentId: "default",
      config,
      agentDir: "/tmp/unused-agent",
      inheritedAuthDir: "/tmp/unused-agent",
      workspaceDir,
    });

    expect(lease.snapshot.workspaceDir).toBe(workspaceDir);
    expect(lease.snapshot.pluginRegistry).toBe(configuredRegistry);
    expect(lease.snapshot.metadataSnapshot.workspaceDir).toBe(workspaceDir);
    expect(mocks.loadAgentRuntimePluginRegistryHandle).toHaveBeenCalledTimes(
      configuredPluginRegistryLoads,
    );
    expect(dynamicPreparationRegistries.every(Boolean)).toBe(true);
    expect(catalogGenerationRegistries.every(Boolean)).toBe(true);
    lease.release();
  });
});
