// Xai API module exposes the plugin public contract.
import { definePluginEntry } from "afora-agent/plugin-sdk/plugin-entry";
import { isRecord } from "afora-agent/plugin-sdk/string-coerce-runtime";

export default definePluginEntry({
  id: "xai",
  name: "xAI Setup",
  description: "Lightweight xAI setup hooks",
  register(api) {
    api.registerAutoEnableProbe(({ config }) => {
      const pluginConfig = config.plugins?.entries?.xai?.config;
      if (
        isRecord(pluginConfig) &&
        (isRecord(pluginConfig.xSearch) || isRecord(pluginConfig.codeExecution))
      ) {
        return "xai tool configured";
      }
      return null;
    });
  },
});
