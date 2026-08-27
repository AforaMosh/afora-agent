// Private runtime barrel for the bundled Nostr extension.
// Keep this barrel thin and aligned with the local extension surface.

export type { AforaConfig } from "afora-agent/plugin-sdk/config-contracts";
export { getPluginRuntimeGatewayRequestScope } from "afora-agent/plugin-sdk/plugin-runtime";
export type { PluginRuntime } from "afora-agent/plugin-sdk/runtime-store";
