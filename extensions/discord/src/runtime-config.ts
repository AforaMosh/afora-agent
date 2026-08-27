// Discord helper module supports runtime config behavior.
import {
  getRuntimeConfigSnapshot,
  getRuntimeConfigSourceSnapshot,
  selectApplicableRuntimeConfig,
} from "afora-agent/plugin-sdk/runtime-config-snapshot";
import type { AforaConfig } from "./runtime-api.js";

export function selectDiscordRuntimeConfig(inputConfig: AforaConfig): AforaConfig {
  return (
    selectApplicableRuntimeConfig({
      inputConfig,
      runtimeConfig: getRuntimeConfigSnapshot(),
      runtimeSourceConfig: getRuntimeConfigSourceSnapshot(),
    }) ?? inputConfig
  );
}
