// ClickClack plugin module implements its setup-only bundled entry.
import { defineBundledChannelSetupEntry } from "afora-agent/plugin-sdk/channel-entry-contract";

export default defineBundledChannelSetupEntry({
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./setup-plugin-api.js",
    exportName: "clickClackSetupPlugin",
  },
  secrets: {
    specifier: "./secret-contract-api.js",
    exportName: "channelSecrets",
  },
});
