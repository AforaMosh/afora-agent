import type { AforaConfig } from "../../config/types.afora.js";
import { markReplyConfigRuntimeMode } from "./reply-config-runtime-mode.js";

export function markCompleteReplyConfig<T extends AforaConfig>(
  config: T,
  options?: { runtimeMode?: "fast" | "full" },
): T {
  return markReplyConfigRuntimeMode(config, options?.runtimeMode ?? "fast");
}

export function withFastReplyConfig<T extends AforaConfig>(config: T): T {
  return markCompleteReplyConfig(config);
}
