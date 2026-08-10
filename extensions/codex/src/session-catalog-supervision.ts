import { readCodexPluginConfig } from "./app-server/config.js";

const DISABLED_MESSAGE = "Codex supervision is disabled. Enable it to continue this session.";

export const codexSupervisionGate = {
  disabledMessage: DISABLED_MESSAGE,
  setupConfigPath: "plugins.entries.codex.config.supervision.enabled",
  enabled(pluginConfig: unknown): boolean {
    return readCodexPluginConfig(pluginConfig).supervision?.enabled === true;
  },
  assertEnabled(pluginConfig: unknown): void {
    if (readCodexPluginConfig(pluginConfig).supervision?.enabled !== true) {
      throw Object.assign(new Error(DISABLED_MESSAGE), {
        code: "CODEX_SUPERVISION_DISABLED",
      });
    }
  },
} as const;
