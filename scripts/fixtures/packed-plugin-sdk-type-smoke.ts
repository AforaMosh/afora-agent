// Packed Plugin Sdk Type Smoke script supports Afora repository automation.
type PublicPluginSdkModules = [
  typeof import("afora-agent/plugin-sdk/core"),
  typeof import("afora-agent/plugin-sdk/channel-entry-contract"),
  typeof import("afora-agent/plugin-sdk/config-contracts"),
  typeof import("afora-agent/plugin-sdk/plugin-entry"),
  typeof import("afora-agent/plugin-sdk/runtime-env"),
];

const resolvedModules = null as unknown as PublicPluginSdkModules;

void resolvedModules;
