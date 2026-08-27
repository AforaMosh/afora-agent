// Twitch plugin module implements runtime behavior.
import type { PluginRuntime } from "afora-agent/plugin-sdk/core";
import { createPluginRuntimeStore } from "afora-agent/plugin-sdk/runtime-store";

const { setRuntime: setTwitchRuntime, getRuntime: getTwitchRuntime } =
  createPluginRuntimeStore<PluginRuntime>({
    pluginId: "twitch",
    errorMessage: "Twitch runtime not initialized",
  });
export { getTwitchRuntime, setTwitchRuntime };
