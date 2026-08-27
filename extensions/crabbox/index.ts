import { definePluginEntry } from "afora-agent/plugin-sdk/plugin-entry";
import { createCrabboxWorkerProvider, resolveAforaRoot } from "./src/crabbox-worker-provider.js";

export default definePluginEntry({
  id: "crabbox",
  name: "Crabbox Worker Provider",
  description: "Cloud worker provider backed by the Crabbox CLI",
  register(api) {
    api.registerWorkerProvider(
      createCrabboxWorkerProvider({
        aforaRoot: resolveAforaRoot(api.rootDir),
        warn: (message) => api.logger.warn(message),
      }),
    );
  },
});
