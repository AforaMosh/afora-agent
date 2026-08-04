import { describe, expect, it, vi } from "vitest";
import { resolveCodexThreadFinalConfigPatch } from "./thread-final-config.js";

describe("resolveCodexThreadFinalConfigPatch", () => {
  it("keeps static safety caps final while retaining per-thread builder state", () => {
    const buildFinalConfigPatch = vi.fn(() => ({
      configPatch: {
        "features.hooks": true,
        mcp_servers: { memory: { enabled: true, enabled_tools: ["read_graph"] } },
      },
      nativeHookRelayGeneration: "generation-next",
    }));

    const result = resolveCodexThreadFinalConfigPatch(
      {
        finalConfigPatch: {
          "features.hooks": false,
          mcp_servers: {
            memory: { enabled: true, enabled_tools: ["create_entities"] },
            addedLater: { enabled: false },
          },
        },
        buildFinalConfigPatch,
        nativeHookRelayGeneration: "generation-static",
      },
      { action: "start" },
    );

    expect(result).toEqual({
      configPatch: {
        "features.hooks": false,
        mcp_servers: {
          memory: { enabled: true, enabled_tools: ["create_entities"] },
          addedLater: { enabled: false },
        },
      },
      nativeHookRelayGeneration: "generation-next",
    });
    expect(buildFinalConfigPatch).toHaveBeenCalledWith({ action: "start" });
  });

  it("uses the static patch when no dynamic builder is present", () => {
    expect(
      resolveCodexThreadFinalConfigPatch(
        {
          finalConfigPatch: { mcp_servers: { memory: { enabled: false } } },
          nativeHookRelayGeneration: "generation-static",
        },
        { action: "start" },
      ),
    ).toEqual({
      configPatch: { mcp_servers: { memory: { enabled: false } } },
      nativeHookRelayGeneration: "generation-static",
    });
  });
});
