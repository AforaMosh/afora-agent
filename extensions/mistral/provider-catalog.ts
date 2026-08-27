// Mistral provider module implements model/runtime integration.
import { buildManifestModelProviderConfig } from "afora-agent/plugin-sdk/provider-catalog-shared";
import type { ModelProviderConfig } from "afora-agent/plugin-sdk/provider-model-shared";
import manifest from "./afora.plugin.json" with { type: "json" };

export function buildMistralProvider(): ModelProviderConfig {
  return buildManifestModelProviderConfig({
    providerId: "mistral",
    catalog: manifest.modelCatalog.providers.mistral,
  });
}
