import { readManifestProviderDefaultModelRef } from "afora-agent/plugin-sdk/provider-catalog-shared";
import { createModelCatalogPresetAppliers } from "afora-agent/plugin-sdk/provider-onboard";
import { DEEPSEEK_BASE_URL, DEEPSEEK_MODEL_CATALOG } from "./models.js";
import manifest from "./afora.plugin.json" with { type: "json" };

const DEEPSEEK_DEFAULT_MODEL_REF = readManifestProviderDefaultModelRef(manifest, "deepseek")!;

export const { applyConfig: applyDeepSeekConfig } = createModelCatalogPresetAppliers<[]>({
  primaryModelRef: DEEPSEEK_DEFAULT_MODEL_REF,
  resolveParams: () => ({
    providerId: "deepseek",
    api: "openai-completions",
    baseUrl: DEEPSEEK_BASE_URL,
    catalogModels: structuredClone(DEEPSEEK_MODEL_CATALOG),
    aliases: [{ modelRef: DEEPSEEK_DEFAULT_MODEL_REF, alias: "DeepSeek" }],
  }),
});
