// Migrate Hermes plugin entrypoint registers its Afora integration.
import { definePluginEntry } from "afora-agent/plugin-sdk/plugin-entry";
import { buildHermesMigrationProvider } from "./provider.js";

export default definePluginEntry({
  id: "migrate-hermes",
  name: "Hermes Migration",
  description: "Imports Hermes state into Afora.",
  register(api) {
    api.registerMigrationProvider(buildHermesMigrationProvider({ runtime: api.runtime }));
  },
});
