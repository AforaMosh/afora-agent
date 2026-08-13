// Discord test API exposes private QA/runtime fixtures.
export { testing as discordGatewayLifecycleTesting } from "./src/monitor/provider.lifecycle.js";
export { setDiscordProviderEndpointDescriptor } from "./src/provider-endpoint.js";
export type { DiscordProviderEndpointDescriptor } from "./src/provider-endpoint.constants.js";
