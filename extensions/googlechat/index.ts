// Googlechat plugin entrypoint registers its Afora integration.
import { defineBundledChannelEntry } from "afora-agent/plugin-sdk/channel-entry-contract";

export default defineBundledChannelEntry({
  id: "googlechat",
  name: "Google Chat",
  description: "Afora Google Chat channel plugin",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./channel-plugin-api.js",
    exportName: "googlechatPlugin",
  },
  secrets: {
    specifier: "./secret-contract-api.js",
    exportName: "channelSecrets",
  },
  runtime: {
    specifier: "./runtime-api.js",
    exportName: "setGoogleChatRuntime",
  },
});
