// Openrouter setup module handles plugin onboarding behavior.
import {
  createAliasOnlyPresetAppliers,
  type AforaConfig,
} from "afora-agent/plugin-sdk/provider-onboard";

export const OPENROUTER_DEFAULT_MODEL_REF = "openrouter/auto";
const openrouterPresetAppliers = createAliasOnlyPresetAppliers({
  modelRef: OPENROUTER_DEFAULT_MODEL_REF,
  alias: "OpenRouter",
});

export function applyOpenrouterProviderConfig(cfg: AforaConfig): AforaConfig {
  return openrouterPresetAppliers.applyProviderConfig(cfg);
}

export function applyOpenrouterConfig(cfg: AforaConfig): AforaConfig {
  return openrouterPresetAppliers.applyConfig(cfg);
}
