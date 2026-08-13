import { listProviderModelAuthorizingProfileIds } from "../../plugins/provider-catalog-outcome.js";
import { getLoadedFullModelCatalog } from "../prepared-model-runtime-full-catalog.js";
import type { PreparedModelRuntimeSnapshot } from "../prepared-model-runtime.js";

export function resolvePreparedRuntimePreferredProfileId(params: {
  provider: string;
  modelId: string;
  preparedModelRuntime?: PreparedModelRuntimeSnapshot;
  requestedProfileId?: string;
  lockedProfileId?: string;
  ignoreAutoPreferredProfile: boolean;
}): string | undefined {
  const loadedCatalog = getLoadedFullModelCatalog(params.preparedModelRuntime);
  const authorizingProfileIds = params.lockedProfileId
    ? []
    : listProviderModelAuthorizingProfileIds({
        outcomes:
          loadedCatalog?.providerOutcomes ??
          params.preparedModelRuntime?.modelCatalog.providerOutcomes,
        provider: params.provider,
        modelId: params.modelId,
      });
  // Discovery made this model selectable with one of these exact profiles. Preserve an already
  // authorizing auto-selection; otherwise bind the first attempt to catalog provenance.
  const catalogAuthorizedProfileId =
    params.requestedProfileId && authorizingProfileIds.includes(params.requestedProfileId)
      ? params.requestedProfileId
      : authorizingProfileIds[0];
  return params.ignoreAutoPreferredProfile && !params.lockedProfileId
    ? undefined
    : (params.lockedProfileId ?? catalogAuthorizedProfileId ?? params.requestedProfileId);
}
