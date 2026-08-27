// Test-only bridge that feeds legacy fixture values through the canonical mediaModels owner.
import type { AforaConfig } from "../../config/types.afora.js";

type MediaCapability = "image" | "music" | "video";
type LegacyMediaModelKey = "imageGenerationModel" | "musicGenerationModel" | "videoGenerationModel";

export function canonicalizeMediaGenerationTestConfig(
  config: AforaConfig,
  capability: MediaCapability,
  legacyKey: LegacyMediaModelKey,
): AforaConfig {
  const defaults = config.agents?.defaults as
    | (NonNullable<AforaConfig["agents"]>["defaults"] & Record<string, unknown>)
    | undefined;
  const legacyValue = defaults?.[legacyKey];
  if (legacyValue === undefined || defaults?.mediaModels?.[capability] !== undefined) {
    return config;
  }
  return {
    ...config,
    agents: {
      ...config.agents,
      defaults: {
        ...defaults,
        mediaModels: { ...defaults?.mediaModels, [capability]: legacyValue },
      },
    },
  };
}
