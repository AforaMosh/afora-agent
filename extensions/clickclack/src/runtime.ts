/**
 * Runtime store for host-provided Afora services used by the ClickClack
 * bundled plugin.
 */
import { createPluginRuntimeStore } from "afora-agent/plugin-sdk/runtime-store";
import type { PluginRuntime } from "afora-agent/plugin-sdk/runtime-store";

const { setRuntime: setClickClackRuntime, getRuntime: getClickClackRuntime } =
  createPluginRuntimeStore<PluginRuntime>({
    pluginId: "clickclack",
    errorMessage: "ClickClack runtime not initialized",
  });

export { getClickClackRuntime, setClickClackRuntime };
