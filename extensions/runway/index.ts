// Runway plugin entrypoint registers its Afora integration.
import { definePluginEntry } from "afora-agent/plugin-sdk/plugin-entry";
import { buildRunwayVideoGenerationProvider } from "./video-generation-provider.js";

export default definePluginEntry({
  id: "runway",
  name: "Runway Provider",
  description: "Bundled Runway video provider plugin",
  register(api) {
    api.registerVideoGenerationProvider(buildRunwayVideoGenerationProvider());
  },
});
