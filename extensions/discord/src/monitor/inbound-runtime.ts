// Discord plugin module defines the trusted inbound runtime boundary.
import type { ChannelRuntimeSurface } from "openclaw/plugin-sdk/channel-contract";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";

/** Paired context construction and execution capability for one Discord ingress event. */
export type DiscordInboundRuntime = Pick<
  PluginRuntime["channel"]["inbound"],
  "buildContext" | "run" | "dispatch"
>;

export type DiscordInboundRuntimeResolver = () => DiscordInboundRuntime;

function isDiscordInboundRuntime(value: unknown): value is DiscordInboundRuntime {
  if (!value || typeof value !== "object") {
    return false;
  }
  const inbound = value as Partial<DiscordInboundRuntime>;
  return (
    typeof inbound.buildContext === "function" &&
    typeof inbound.run === "function" &&
    typeof inbound.dispatch === "function"
  );
}

/**
 * Resolve the gateway-owned facade lazily, so startup-only test paths do not
 * need an inbound runtime. Real ingress must fail closed instead of downgrading
 * to the public unprivileged helpers.
 */
export function resolveDiscordInboundRuntime(
  channelRuntime: ChannelRuntimeSurface | undefined,
): DiscordInboundRuntime {
  const inbound = channelRuntime?.["inbound"];
  if (!isDiscordInboundRuntime(inbound)) {
    throw new Error("Discord inbound runtime is unavailable for a live ingress event.");
  }
  return inbound;
}
