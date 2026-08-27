import type { AforaConfig } from "../../config/types.afora.js";

// Reply completeness is process-local metadata. Keep it off config objects so
// frozen runtime snapshots and identity-keyed caches remain valid.
const replyConfigRuntimeModes = new WeakMap<AforaConfig, "fast" | "full">();

export function markReplyConfigRuntimeMode<T extends AforaConfig>(
  config: T,
  runtimeMode: "fast" | "full",
): T {
  replyConfigRuntimeModes.set(config, runtimeMode);
  return config;
}

export function isCompleteReplyConfig(config: unknown): config is AforaConfig {
  return Boolean(
    config && typeof config === "object" && replyConfigRuntimeModes.has(config as AforaConfig),
  );
}

export function usesFullReplyRuntime(config: unknown): boolean {
  if (!config || typeof config !== "object") {
    return false;
  }
  const mode = replyConfigRuntimeModes.get(config as AforaConfig);
  return mode === "full";
}
