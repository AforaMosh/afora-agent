// Imessage plugin module implements runtime behavior.
import type { PluginRuntime } from "afora-agent/plugin-sdk/core";
import { createPluginRuntimeStore } from "afora-agent/plugin-sdk/runtime-store";

const {
  getRuntime: getIMessageRuntime,
  setRuntime: setIMessageRuntime,
  tryGetRuntime: getOptionalIMessageRuntime,
} = createPluginRuntimeStore<PluginRuntime>({
  pluginId: "imessage",
  errorMessage: "iMessage runtime not initialized",
});
export { getIMessageRuntime, getOptionalIMessageRuntime, setIMessageRuntime };
