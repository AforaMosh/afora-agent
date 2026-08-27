/**
 * Cerebras model provider builder.
 */
import { buildManifestModelProviderConfig } from "afora-agent/plugin-sdk/provider-catalog-shared";
import type { ModelProviderConfig } from "afora-agent/plugin-sdk/provider-model-shared";
import manifest from "./afora.plugin.json" with { type: "json" };

/** Builds the Cerebras OpenAI-compatible model provider config. */
export function buildCerebrasProvider(): ModelProviderConfig {
  return buildManifestModelProviderConfig({
    providerId: "cerebras",
    catalog: manifest.modelCatalog.providers.cerebras,
  });
}
