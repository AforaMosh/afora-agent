// Qwen setup module handles plugin onboarding behavior.
import {
  createModelCatalogPresetAppliers,
  type AforaConfig,
} from "afora-agent/plugin-sdk/provider-onboard";
import {
  QWEN_CN_BASE_URL,
  QWEN_DEFAULT_MODEL_REF,
  QWEN_GLOBAL_BASE_URL,
  QWEN_STANDARD_CN_BASE_URL,
  QWEN_STANDARD_GLOBAL_BASE_URL,
  QWEN_TOKEN_PLAN_DEFAULT_MODEL_REF,
  QWEN_TOKEN_PLAN_PROVIDER_ID,
  type QwenTokenPlanRegion,
  resolveQwenTokenPlanBaseUrl,
} from "./models.js";
import { buildQwenProvider, buildQwenTokenPlanProvider } from "./provider-catalog.js";

const qwenPresetAppliers = createModelCatalogPresetAppliers<[string]>({
  primaryModelRef: QWEN_DEFAULT_MODEL_REF,
  resolveParams: (_cfg: AforaConfig, baseUrl: string) => {
    const provider = buildQwenProvider({ baseUrl });
    return {
      providerId: "qwen",
      api: provider.api ?? "openai-completions",
      baseUrl,
      catalogModels: provider.models ?? [],
      aliases: [
        ...(provider.models ?? []).flatMap((model) => [
          `qwen/${model.id}`,
          `modelstudio/${model.id}`,
        ]),
        { modelRef: QWEN_DEFAULT_MODEL_REF, alias: "Qwen" },
      ],
    };
  },
});

const qwenTokenPlanPresetAppliers = createModelCatalogPresetAppliers<[string]>({
  primaryModelRef: QWEN_TOKEN_PLAN_DEFAULT_MODEL_REF,
  resolveParams: (_cfg: AforaConfig, baseUrl: string) => {
    const provider = buildQwenTokenPlanProvider({ baseUrl });
    return {
      providerId: QWEN_TOKEN_PLAN_PROVIDER_ID,
      api: provider.api ?? "openai-completions",
      baseUrl,
      catalogModels: provider.models ?? [],
      aliases: [
        ...(provider.models ?? []).map((model) => `${QWEN_TOKEN_PLAN_PROVIDER_ID}/${model.id}`),
        { modelRef: QWEN_TOKEN_PLAN_DEFAULT_MODEL_REF, alias: "Qwen Token Plan" },
      ],
    };
  },
});

export function applyQwenConfig(cfg: AforaConfig): AforaConfig {
  return qwenPresetAppliers.applyConfig(cfg, QWEN_GLOBAL_BASE_URL);
}

export function applyQwenConfigCn(cfg: AforaConfig): AforaConfig {
  return qwenPresetAppliers.applyConfig(cfg, QWEN_CN_BASE_URL);
}

export function applyQwenStandardConfig(cfg: AforaConfig): AforaConfig {
  return qwenPresetAppliers.applyConfig(cfg, QWEN_STANDARD_GLOBAL_BASE_URL);
}

export function applyQwenStandardConfigCn(cfg: AforaConfig): AforaConfig {
  return qwenPresetAppliers.applyConfig(cfg, QWEN_STANDARD_CN_BASE_URL);
}

export function applyQwenTokenPlanConfig(
  cfg: AforaConfig,
  region: QwenTokenPlanRegion,
): AforaConfig {
  return qwenTokenPlanPresetAppliers.applyConfig(cfg, resolveQwenTokenPlanBaseUrl(region));
}
