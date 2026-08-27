// Vydra setup module handles plugin onboarding behavior.
import type { AforaConfig } from "afora-agent/plugin-sdk/provider-onboard";

export const VYDRA_DEFAULT_IMAGE_MODEL_REF = "vydra/grok-imagine";

export function applyVydraConfig(cfg: AforaConfig): AforaConfig {
  if (cfg.agents?.defaults?.mediaModels?.image) {
    return cfg;
  }
  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...cfg.agents?.defaults,
        mediaModels: {
          ...cfg.agents?.defaults?.mediaModels,
          image: { primary: VYDRA_DEFAULT_IMAGE_MODEL_REF },
        },
      },
    },
  };
}
