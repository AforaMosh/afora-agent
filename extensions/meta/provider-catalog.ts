/**
 * Meta model provider builder.
 */
import { buildManifestModelProviderConfig } from "afora-agent/plugin-sdk/provider-catalog-shared";
import type { ModelProviderConfig } from "afora-agent/plugin-sdk/provider-model-shared";
import manifest from "./afora.plugin.json" with { type: "json" };

/** Builds the Meta OpenAI-compatible model provider config. */
export function buildMetaProvider(): ModelProviderConfig {
  return buildManifestModelProviderConfig({
    providerId: "meta",
    catalog: manifest.modelCatalog.providers.meta,
  });
}
