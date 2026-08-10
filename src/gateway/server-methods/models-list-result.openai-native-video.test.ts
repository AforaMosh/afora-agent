import { describe, expect, it, vi } from "vitest";
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { buildModelsListResult } from "./models-list-result.js";
import type { GatewayRequestContext } from "./types.js";

async function listModels(catalog: ModelCatalogEntry[]) {
  const config = {} as OpenClawConfig;
  const context = {
    getRuntimeConfig: () => config,
    loadGatewayModelCatalog: vi.fn(() => Promise.resolve(catalog)),
    loadGatewayModelCatalogSnapshot: vi.fn(() =>
      Promise.resolve({
        agentId: "main",
        agentDir: "/tmp/models-list-openai-native-video-agent",
        config,
        entries: catalog,
        routeVariants: catalog,
      }),
    ),
    logGateway: { debug: vi.fn() },
  } as unknown as GatewayRequestContext;
  return await buildModelsListResult({ context, params: { view: "all" } });
}

describe("models.list OpenAI native video", () => {
  it("projects the route-qualified native-video fact without private route details", async () => {
    const result = await listModels([
      {
        id: "kimi-k3",
        name: "Kimi K3",
        provider: "moonshot",
        api: "openai-completions",
        baseUrl: "https://api.moonshot.ai/v1",
        input: ["text", "video"],
        supportsNativeVideo: true,
      },
    ]);

    expect(result.models).toEqual([
      expect.objectContaining({
        id: "kimi-k3",
        provider: "moonshot",
        supportsNativeVideo: true,
      }),
    ]);
    expect(result.models[0]).not.toHaveProperty("baseUrl");
    expect(result.models[0]).not.toHaveProperty("nativeVideoInput");
  });
});
