// Gradium plugin entrypoint registers its Afora integration.
import { definePluginEntry } from "afora-agent/plugin-sdk/plugin-entry";
import { buildGradiumSpeechProvider } from "./speech-provider.js";

export default definePluginEntry({
  id: "gradium",
  name: "Gradium Speech",
  description: "Bundled Gradium speech provider",
  register(api) {
    api.registerSpeechProvider(buildGradiumSpeechProvider());
  },
});
