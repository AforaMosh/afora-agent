// Irc plugin module implements runtime behavior.
import { createPluginRuntimeStore } from "afora-agent/plugin-sdk/runtime-store";
import type { PluginRuntime } from "./runtime-api.js";

const { setRuntime: setIrcRuntime, getRuntime: getIrcRuntime } =
  createPluginRuntimeStore<PluginRuntime>({
    pluginId: "irc",
    errorMessage: "IRC runtime not initialized",
  });
export { getIrcRuntime, setIrcRuntime };
