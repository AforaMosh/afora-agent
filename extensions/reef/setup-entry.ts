import { defineBundledChannelSetupEntry } from "afora-agent/plugin-sdk/channel-entry-contract";

export default defineBundledChannelSetupEntry({
  importMetaUrl: import.meta.url,
  plugin: { specifier: "./channel-plugin-api.js", exportName: "reefPlugin" },
  runtime: { specifier: "./runtime-api.js", exportName: "setReefRuntime" },
});
