// Deepinfra setup module handles plugin onboarding behavior.
import {
  createAliasOnlyPresetAppliers,
  type AforaConfig,
} from "afora-agent/plugin-sdk/provider-onboard";
import { DEEPINFRA_DEFAULT_MODEL_REF } from "./provider-models.js";

export function applyDeepInfraConfig(
  cfg: AforaConfig,
  modelRef: string = DEEPINFRA_DEFAULT_MODEL_REF,
): AforaConfig {
  return createAliasOnlyPresetAppliers({ modelRef, alias: "DeepInfra" }).applyConfig(cfg);
}
