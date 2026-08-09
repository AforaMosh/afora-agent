// Discord inbound runtime tests protect the live gateway capability boundary.
import type { ChannelRuntimeSurface } from "openclaw/plugin-sdk/channel-contract";
import { describe, expect, it, vi } from "vitest";
import { type DiscordInboundRuntime, resolveDiscordInboundRuntime } from "./inbound-runtime.js";

const LIVE_INGRESS_ERROR = "Discord inbound runtime is unavailable for a live ingress event.";

function withInboundRuntime(inbound: unknown): ChannelRuntimeSurface {
  return { inbound } as ChannelRuntimeSurface;
}

describe("resolveDiscordInboundRuntime", () => {
  it("rejects a missing gateway-owned facade when live ingress resolves it", () => {
    expect(() => resolveDiscordInboundRuntime(undefined)).toThrow(LIVE_INGRESS_ERROR);
  });

  it("rejects an incomplete gateway-owned facade when live ingress resolves it", () => {
    const incompleteInbound = {
      buildContext: vi.fn(),
      run: vi.fn(),
    };

    expect(() => resolveDiscordInboundRuntime(withInboundRuntime(incompleteInbound))).toThrow(
      LIVE_INGRESS_ERROR,
    );
  });

  it("returns the exact complete gateway-owned facade", () => {
    const inbound = {
      buildContext: vi.fn(),
      run: vi.fn(),
      dispatch: vi.fn(),
    } as unknown as DiscordInboundRuntime;

    expect(resolveDiscordInboundRuntime(withInboundRuntime(inbound))).toBe(inbound);
  });
});
