import { defineBundledChannelSetupEntry } from "afora-agent/plugin-sdk/channel-entry-contract";

export default defineBundledChannelSetupEntry({
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./setup-plugin-api.js",
    exportName: "buzzSetupPlugin",
  },
  secrets: {
    specifier: "./secret-contract-api.js",
    exportName: "channelSecrets",
  },
});
