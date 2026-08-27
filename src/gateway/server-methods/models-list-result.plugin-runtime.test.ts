import { describe, expect, it, vi } from "vitest";
import type { ModelCatalogEntry, ModelCatalogSnapshot } from "../../agents/model-catalog.types.js";
import type { AforaConfig } from "../../config/types.afora.js";
import { withAforaTestState } from "../../test-utils/afora-test-state.js";
import {
  buildModelsListResult,
  createGatewayAgentModelCatalogProjector,
} from "./models-list-result.js";
import type { GatewayRequestContext } from "./types.js";

function catalogEntry(id: string): ModelCatalogEntry {
  return { id, name: id, provider: "custom", api: "openai-responses" };
}

function preparedMetadataSnapshot() {
  return {
    index: {
      plugins: [
        {
          enabled: true,
          syntheticAuthRefs: ["custom"],
        },
      ],
    },
    plugins: [
      {
        modelIdNormalization: {
          providers: {
            custom: {
              aliases: {
                legacy: "modern",
              },
            },
          },
        },
      },
    ],
  } as never;
}

describe("models.list plugin metadata handoff", () => {
  it("reuses one Gateway-owned metadata snapshot across startup projection and browse", async () => {
    await withAforaTestState(
      {
        layout: "state-only",
        prefix: "afora-models-list-plugin-runtime-",
        agentEnv: "main",
      },
      async (state) => {
        const cfg = {
          agents: {
            defaults: {
              workspace: state.workspaceDir,
              model: { primary: "custom/legacy" },
              models: {
                "custom/legacy": {},
                "custom/another": {},
              },
            },
          },
        } as AforaConfig;
        const snapshot: ModelCatalogSnapshot = {
          entries: [catalogEntry("modern"), catalogEntry("another")],
          routeVariants: [],
        };
        const projector = createGatewayAgentModelCatalogProjector({
          cfg,
          agentId: "main",
          snapshot,
          metadataSnapshot: preparedMetadataSnapshot(),
          preparedAuthStore: { version: 1, profiles: {} },
        });
        await projector.projectCatalog();

        const context = {
          getRuntimeConfig: () => cfg,
          loadGatewayModelCatalogSnapshot: vi.fn(),
          logGateway: { debug: vi.fn() },
        } as unknown as GatewayRequestContext;
        await buildModelsListResult({
          context,
          agentId: "main",
          params: { view: "configured" },
          preloadedCatalog: { agentId: "main", config: cfg, snapshot },
          preloadedOnly: true,
          catalogProjector: projector,
        });
      },
    );
  });

  it("keeps prepared owner facts when preloaded-only browse requires full discovery", async () => {
    const cfg = {
      agents: { defaults: { models: { "custom/*": {} } } },
    } as AforaConfig;
    const snapshot: ModelCatalogSnapshot = { entries: [], routeVariants: [] };
    const loadGatewayModelCatalogSnapshot = vi.fn();
    const context = {
      getRuntimeConfig: () => cfg,
      loadGatewayModelCatalogSnapshot,
      logGateway: { debug: vi.fn() },
    } as unknown as GatewayRequestContext;
    const projector = createGatewayAgentModelCatalogProjector({
      cfg,
      agentId: "main",
      snapshot,
      metadataSnapshot: preparedMetadataSnapshot(),
      preparedAuthStore: { version: 1, profiles: {} },
    });

    await buildModelsListResult({
      context,
      params: { view: "configured" },
      preloadedCatalog: { agentId: "main", config: cfg, snapshot },
      preloadedOnly: true,
      catalogProjector: projector,
    });

    expect(loadGatewayModelCatalogSnapshot).not.toHaveBeenCalled();
  });
});
