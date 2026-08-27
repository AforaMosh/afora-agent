// Qianfan provider module implements model/runtime integration.
import { buildManifestModelProviderConfig } from "afora-agent/plugin-sdk/provider-catalog-shared";
import type { ModelProviderConfig } from "afora-agent/plugin-sdk/provider-model-shared";
import manifest from "./afora.plugin.json" with { type: "json" };

export const QIANFAN_BASE_URL = "https://qianfan.baidubce.com/v2";
export const QIANFAN_DEFAULT_MODEL_ID = "deepseek-v4-pro";

export function buildQianfanProvider(): ModelProviderConfig {
  return buildManifestModelProviderConfig({
    providerId: "qianfan",
    catalog: manifest.modelCatalog.providers.qianfan,
  });
}
