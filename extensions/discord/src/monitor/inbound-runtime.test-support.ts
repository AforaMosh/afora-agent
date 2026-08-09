// Discord test helper builds the deliberately unprivileged inbound facade.
import {
  buildChannelInboundEventContext,
  dispatchChannelInboundTurn,
  runChannelInboundEvent,
} from "openclaw/plugin-sdk/channel-inbound";
import type { DiscordInboundRuntime, DiscordInboundRuntimeResolver } from "./inbound-runtime.js";

/**
 * Test-only facade backed by the public SDK entrypoints. It is deliberately
 * unprivileged: production ingress must receive the gateway-owned facade.
 */
export function createDiscordTestInboundRuntime(
  overrides: Partial<DiscordInboundRuntime> = {},
): DiscordInboundRuntime {
  return {
    buildContext: overrides.buildContext ?? buildChannelInboundEventContext,
    run: overrides.run ?? runChannelInboundEvent,
    dispatch: overrides.dispatch ?? dispatchChannelInboundTurn,
  };
}

export function createDiscordTestInboundRuntimeResolver(
  overrides: Partial<DiscordInboundRuntime> = {},
): DiscordInboundRuntimeResolver {
  const inbound = createDiscordTestInboundRuntime(overrides);
  return () => inbound;
}
