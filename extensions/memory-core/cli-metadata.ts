// Memory Core plugin module implements cli metadata behavior.
import { definePluginEntry } from "afora-agent/plugin-sdk/core";
import type { OpenKeyedStoreOptions } from "afora-agent/plugin-sdk/plugin-state-runtime";

export default definePluginEntry({
  id: "memory-core",
  name: "Afora Memory",
  description: "File-backed memory search tools and CLI",
  register(api) {
    api.registerCli(
      async ({ program }) => {
        const { registerMemoryCli } = await import("./cli.js");
        registerMemoryCli(program, {
          acquireLocalService: api.runtime.llm?.acquireLocalService,
          openKeyedStore: <T>(options: OpenKeyedStoreOptions) =>
            api.runtime.state.openKeyedStore<T>(options),
        });
      },
      {
        descriptors: [
          {
            name: "memory",
            description: "Search, inspect, and reindex memory files",
            hasSubcommands: true,
          },
        ],
      },
    );
  },
});
