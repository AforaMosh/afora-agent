// Public model-catalog facade. Keep exports here curated so callers use the
// normalized planning APIs instead of reaching into provider-index internals.
import type { ModelCatalogProvider } from "@afora/model-catalog-core/model-catalog-types";
import type { AforaConfig } from "../config/types.afora.js";
import {
  planManifestModelCatalogRows,
  type ManifestModelCatalogRowSelection,
} from "./manifest-planner.js";
import { getRemoteModelCatalogOverlay } from "./remote-overlay.js";
export { loadAforaProviderIndex } from "./provider-index/index.js";
export { planManifestModelCatalogSuppressions } from "./manifest-planner.js";

export function planEffectiveModelCatalogRows(params: {
  registry: Parameters<typeof planManifestModelCatalogRows>[0]["registry"];
  config: AforaConfig;
  providerFilter?: string;
  selection?: ManifestModelCatalogRowSelection;
}) {
  const remoteOverlay: Readonly<Record<string, ModelCatalogProvider>> | undefined =
    getRemoteModelCatalogOverlay(params.config);
  return planManifestModelCatalogRows({
    registry: params.registry,
    ...(params.providerFilter ? { providerFilter: params.providerFilter } : {}),
    ...(remoteOverlay ? { remoteOverlay } : {}),
    ...(params.selection ? { selection: params.selection } : {}),
  });
}
export type { ManifestModelCatalogSuppressionEntry } from "./manifest-planner.js";
export type { AforaProviderIndexProvider } from "./provider-index/index.js";
