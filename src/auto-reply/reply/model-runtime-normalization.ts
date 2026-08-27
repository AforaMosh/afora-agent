/** Prepared plugin metadata handoff for runtime model normalization. */
import { normalizeModelRef } from "../../agents/model-selection.js";
import { RUNTIME_MODEL_VISIBILITY_NORMALIZATION } from "../../agents/model-visibility-policy.js";
import type { AforaConfig } from "../../config/types.afora.js";
import { getCurrentPluginMetadataSnapshot } from "../../plugins/current-plugin-metadata-snapshot.js";

export type RuntimeModelNormalization = NonNullable<Parameters<typeof normalizeModelRef>[2]>;

/** Carries the Gateway-owned metadata snapshot through one model-selection run. */
export function resolveRuntimeNormalization(cfg: AforaConfig): RuntimeModelNormalization {
  return {
    ...RUNTIME_MODEL_VISIBILITY_NORMALIZATION,
    manifestPlugins: getCurrentPluginMetadataSnapshot({
      config: cfg,
      allowWorkspaceScopedSnapshot: true,
    })?.plugins,
  };
}

export function normalizeRuntimeRef(
  provider: string,
  model: string,
  normalization: RuntimeModelNormalization = RUNTIME_MODEL_VISIBILITY_NORMALIZATION,
) {
  return normalizeModelRef(provider, model, normalization);
}
