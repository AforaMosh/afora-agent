// Zalo plugin module implements runtime behavior.
import { createPluginRuntimeStore } from "afora-agent/plugin-sdk/runtime-store";
import type { PluginRuntime } from "./runtime-support.js";

const { setRuntime: setZaloRuntime, getRuntime: getZaloRuntime } =
  createPluginRuntimeStore<PluginRuntime>({
    pluginId: "zalo",
    errorMessage: "Zalo runtime not initialized",
  });
export { getZaloRuntime, setZaloRuntime };
