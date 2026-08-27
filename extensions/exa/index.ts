// Exa plugin entrypoint registers its Afora integration.
import { definePluginEntry } from "afora-agent/plugin-sdk/plugin-entry";
import { createExaWebSearchProvider } from "./src/exa-web-search-provider.js";

export default definePluginEntry({
  id: "exa",
  name: "Exa Plugin",
  description: "Bundled Exa web search plugin",
  register(api) {
    api.registerWebSearchProvider(createExaWebSearchProvider());
  },
});
