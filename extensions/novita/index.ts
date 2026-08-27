// Novita plugin entrypoint registers its Afora integration.
import { readConfiguredProviderCatalogEntries } from "afora-agent/plugin-sdk/provider-catalog-shared";
import { defineSingleProviderPluginEntry } from "afora-agent/plugin-sdk/provider-entry";
import { buildProviderReplayFamilyHooks } from "afora-agent/plugin-sdk/provider-model-shared";
import { buildProviderToolCompatFamilyHooks } from "afora-agent/plugin-sdk/provider-tools";
import manifest from "./afora.plugin.json" with { type: "json" };

const PROVIDER_ID = "novita";

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "NovitaAI Provider",
  description: "Official Afora NovitaAI provider plugin",
  manifest,
  provider: {
    label: "NovitaAI",
    docsPath: "/providers/novita",
    aliases: ["novita-ai", "novitaai"],
    manifestAuth: {
      noteTitle: "NovitaAI",
      noteMessage: "Manage API keys at https://novita.ai/settings/key-management",
    },
    catalog: {
      allowExplicitBaseUrl: true,
      liveModelDiscovery: true,
    },
    augmentModelCatalog: ({ config }) =>
      readConfiguredProviderCatalogEntries({
        config,
        providerId: PROVIDER_ID,
      }),
    ...buildProviderReplayFamilyHooks({
      family: "openai-compatible",
      dropReasoningFromHistory: false,
    }),
    ...buildProviderToolCompatFamilyHooks("openai"),
  },
});
