import type { ModelCatalogSnapshot } from "../agents/model-catalog.types.js";
import type { AforaConfig } from "../config/types.afora.js";

export type GatewayModelCatalogSnapshot = ModelCatalogSnapshot & {
  agentId: string;
  agentDir: string;
  catalogComplete: boolean;
  workspaceDir: string;
  config: AforaConfig;
};
