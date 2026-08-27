// Google API module exposes the plugin public contract.
import { definePluginEntry } from "afora-agent/plugin-sdk/plugin-entry";
import { buildGoogleGeminiCliBackend } from "./cli-backend.js";
import { createGoogleVertexProvider } from "./provider-contract-api.js";

export default definePluginEntry({
  id: "google",
  name: "Google Setup",
  description: "Lightweight Google setup hooks",
  register(api) {
    api.registerProvider(createGoogleVertexProvider());
    api.registerCliBackend(buildGoogleGeminiCliBackend());
  },
});
