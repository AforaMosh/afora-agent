// Nextcloud Talk plugin module implements runtime behavior.
import { createPluginRuntimeStore } from "afora-agent/plugin-sdk/runtime-store";
import type { PluginRuntime } from "afora-agent/plugin-sdk/runtime-store";

const { setRuntime: setNextcloudTalkRuntime, getRuntime: getNextcloudTalkRuntime } =
  createPluginRuntimeStore<PluginRuntime>({
    pluginId: "nextcloud-talk",
    errorMessage: "Nextcloud Talk runtime not initialized",
  });
export { getNextcloudTalkRuntime, setNextcloudTalkRuntime };
